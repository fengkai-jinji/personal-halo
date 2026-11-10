// personal-halo ZCode adapter (new implementation; no upstream equivalent).
// Sources, merged by session id (verified identical namespace in audit):
// 1. ~/.zcode/cli/db/db.sqlite — the real event store: session (parent_id),
//    tool_usage (running/completed per tool_call_id), part (json_extract
//    $.type only — live thinking/streaming activity; no content leaves the
//    DB), turn_usage (terminal rows), todo (plan snapshot), model_usage.
// 2. ~/.zcode/v2/tasks-index.sqlite — task metadata only (terminal
//    task_status; archived/deleted excluded; created_at=0 rows skipped).
// Rules per audit/Codex-B阶段审查与修订任务.md:
// - Every enrichment signal belongs to a session in the metadata-discovered
//   alive set and carries the SOURCE activity time (never the query time).
// - Token accounting: exact per-session sums with a single model_usage scope;
//   per (session, logical_request_id) only the terminal attempt with the
//   highest attempt_index counts; status='completed' only. turn_usage is used
//   for turn-boundary pulses, never added to tokens.
// - Models: one latest row per session (stable started_at/id order).
// - Open tools are tracked by row id until a terminal status appears, so a
//   tool finishing after the 15-minute discovery window still closes.
// - Database activity time proves recency only — running state comes solely
//   from open tool_usage rows / part activity.
import path from 'node:path';
import { readSQLite } from '../util/sqlite.js';
import { taskStatus } from '../util/sanitize.js';

const SESSION_LIMIT = 32;
const TOOL_WINDOW_MS = 15 * 60 * 1000;
const TOOL_SEEN_CAP = 2048;
const TURN_SEEN_CAP = 512;

function prune(map, cap) {
  if (map.size <= cap) return;
  for (const key of map.keys()) {
    map.delete(key);
    if (map.size <= cap) break;
  }
}

async function pollDb(ctx) {
  return readSQLite(ctx.file, db => {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (!tables.has('session') || !tables.has('tool_usage')) { ctx.fail('SchemaUnsupported'); return []; }
    const st = ctx.state;
    st.sessions ??= new Map();
    st.models ??= new Map();
    st.tokens ??= new Map();
    st.tools ??= new Map();
    st.openTools ??= new Map();
    st.turns ??= new Set();
    st.todo ??= new Map();
    st.toolWatermark ??= 0;
    st.partWatermark ??= 0;
    st.turnWatermark ??= 0;
    const meta = [];
    const activity = [];
    const add = (list, t, sid, at, fields = {}) => list.push({ t, sid, at, ...fields });

    // Sessions (top-level and subagent children; parent linkage via parent_id).
    const rows = db.prepare(
      `SELECT id, parent_id, title, directory, time_created, time_updated
       FROM session ORDER BY time_updated DESC LIMIT ${SESSION_LIMIT}`).all();
    const alive = new Set();
    for (const row of rows) {
      alive.add(row.id);
      const prev = st.sessions.get(row.id);
      if (prev && prev.updated === row.time_updated && prev.title === row.title) continue;
      st.sessions.set(row.id, { updated: row.time_updated, title: row.title });
      add(meta, 'meta', row.id, row.time_updated > 0 ? row.time_updated : 1, {
        title: row.title ?? undefined,
        project: row.directory ?? undefined,
        parentSid: row.parent_id ?? undefined,
        startedAt: row.time_created > 0 ? row.time_created : undefined,
      });
    }
    for (const sid of [...st.sessions.keys()]) if (!alive.has(sid)) st.sessions.delete(sid);

    // Model per session: the single latest row (stable started_at/id order),
    // emitted once per change, at the source row's time.
    const modelRows = db.prepare(
      `SELECT id, session_id, model_id, started_at FROM model_usage
       ORDER BY started_at DESC, id DESC LIMIT 400`).all();
    const latestModel = new Map();
    for (const row of modelRows) if (!latestModel.has(row.session_id)) latestModel.set(row.session_id, row);
    for (const [sid, row] of latestModel) {
      if (!alive.has(sid) || !row.model_id) continue;
      if (st.models.get(sid) === row.model_id) continue;
      st.models.set(sid, row.model_id);
      add(meta, 'meta', sid, Math.max(row.started_at ?? 1, 1), { model: row.model_id });
    }

    // Tokens: exact per-session sums over terminal attempts only (single
    // model_usage scope; highest attempt per logical request wins; completed
    // only). Source time = latest contributing completed_at.
    const usage = db.prepare(
      `SELECT session_id,
              SUM(input_tokens) AS input, SUM(output_tokens) AS output,
              SUM(reasoning_tokens) AS reasoning, SUM(cache_read_input_tokens) AS cacheRead,
              SUM(computed_total_tokens) AS total, MAX(completed_at) AS lastAt
       FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY session_id, logical_request_id
           ORDER BY attempt_index DESC, completed_at DESC, id DESC) AS rn
         FROM model_usage WHERE status IN ('completed','error','cancelled')
       ) WHERE rn = 1 AND status = 'completed'
       GROUP BY session_id`).all();
    for (const row of usage) {
      if (!alive.has(row.session_id)) continue;
      const prev = st.tokens.get(row.session_id);
      if (prev && prev.input === row.input && prev.output === row.output && prev.total === row.total) continue;
      add(activity, 'tokens', row.session_id, Math.max(row.lastAt ?? 1, 1),
        { input: row.input, output: row.output, reasoning: row.reasoning, cacheRead: row.cacheRead, total: row.total, mode: 'cumulative' });
      st.tokens.set(row.session_id, { input: row.input, output: row.output, total: row.total });
    }

    // Live tools. Running rows are tracked by row id until a terminal status
    // appears (even far beyond the discovery window); terminals inside the
    // window without a prior running observation are history, not replayed.
    const openIds = [...st.openTools.keys()];
    const openClause = openIds.length ? ` OR id IN (${openIds.map(() => '?').join(',')})` : '';
    const toolRows = db.prepare(
      `SELECT id, session_id, tool_call_id, tool_name, status, started_at, completed_at
       FROM tool_usage WHERE status = 'running' OR started_at > ?${openClause}
       ORDER BY started_at ASC LIMIT 512`).all(ctx.now() - TOOL_WINDOW_MS, ...openIds);
    for (const row of toolRows) {
      if (!alive.has(row.session_id)) continue; // tool activity belongs to discovered sessions
      const seen = st.tools.get(row.id);
      if (row.status === 'running') {
        if (!seen) {
          st.tools.set(row.id, 'running');
          st.openTools.set(row.id, true);
          add(activity, 'tool_start', row.session_id, Math.max(row.started_at ?? 1, 1), { tool: row.tool_name, callId: row.tool_call_id });
        }
        continue;
      }
      if (seen === 'running' || st.openTools.has(row.id)) {
        st.tools.set(row.id, row.status);
        st.openTools.delete(row.id);
        add(activity, 'tool_end', row.session_id, Math.max(row.completed_at ?? row.started_at ?? 1, 1),
          { callId: row.tool_call_id, ok: row.status === 'completed' });
      } else {
        st.tools.set(row.id, 'terminal'); // historical terminal: state only, no replay
      }
      prune(st.tools, TOOL_SEEN_CAP);
    }
    prune(st.openTools, TOOL_SEEN_CAP);

    // Live streaming activity: part rows project only their type field.
    // Startup recovery initializes the cursor to the newest row without
    // replaying history — old thinking/text parts are never evidence of a
    // currently running/waiting session (audit/Codex-B阶段二次复审.md #2).
    if (st.partInitialized === undefined) {
      const row = db.prepare('SELECT MAX(time_created) AS m FROM part').get();
      st.partWatermark = row?.m ?? 0;
      st.partInitialized = true;
    } else {
      const partRows = db.prepare(
        `SELECT id, session_id, time_created, json_extract(data, '$.type') AS ptype
         FROM part WHERE time_created > ? ORDER BY time_created ASC LIMIT 512`).all(st.partWatermark);
      for (const row of partRows) {
        if (row.time_created > st.partWatermark) st.partWatermark = row.time_created;
        if (!alive.has(row.session_id)) continue; // excluded sessions get no ghost activity
        if (row.ptype === 'reasoning') add(activity, 'thinking', row.session_id, row.time_created);
        else if (row.ptype === 'text') add(activity, 'text', row.session_id, row.time_created);
      }
    }

    // Turn boundaries: terminal turn_usage rows pulse start+end once each.
    const turnRows = db.prepare(
      `SELECT session_id, turn_id, status, started_at, completed_at FROM turn_usage
       WHERE completed_at > ? ORDER BY completed_at ASC LIMIT 256`).all(st.turnWatermark);
    for (const row of turnRows) {
      if (row.completed_at > st.turnWatermark) st.turnWatermark = row.completed_at;
      if (!row.turn_id || st.turns.has(row.turn_id)) continue;
      st.turns.add(row.turn_id);
      prune(st.turns, TURN_SEEN_CAP);
      if (!alive.has(row.session_id)) continue; // terminal pairs never revive excluded sessions
      add(activity, 'turn_start', row.session_id, Math.max(row.started_at ?? 1, 1));
      add(activity, 'turn_end', row.session_id, Math.max(row.completed_at ?? 1, 1), { ok: row.status === 'completed' });
    }

    // Plan snapshot: todo table per session, stamped with the source update time.
    for (const row of db.prepare(
      `SELECT session_id, COUNT(*) AS n, MAX(time_updated) AS m FROM todo GROUP BY session_id`).all()) {
      const prev = st.todo.get(row.session_id);
      if (prev && prev.n === row.n && prev.m === row.m) continue;
      st.todo.set(row.session_id, { n: row.n, m: row.m });
      if (!alive.has(row.session_id)) continue;
      const items = db.prepare(
        `SELECT content, status FROM todo WHERE session_id = ? ORDER BY position ASC`).all(row.session_id)
        .map(i => ({ text: i.content, status: taskStatus(i.status) })).filter(i => i.status);
      if (items.length) add(activity, 'tasks', row.session_id, Math.max(row.m ?? 1, 1), { items });
    }

    // Within one poll batch the store applies signals in array order; emit
    // metadata first, then activity in chronological order so the state
    // machine never walks backwards in time.
    activity.sort((a, b) => a.at - b.at);
    return [...meta, ...activity];
  });
}

async function pollTaskIndex(ctx) {
  return readSQLite(ctx.file, db => {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (!tables.has('tasks')) { ctx.fail('SchemaUnsupported'); return []; }
    const st = ctx.state;
    st.index ??= new Map();
    const out = [];
    const rows = db.prepare(
      `SELECT task_id, title, task_status, mode, model, workspace_path, created_at, updated_at
       FROM tasks WHERE archived = 0 AND deleted = 0 ORDER BY updated_at DESC LIMIT ${SESSION_LIMIT}`).all();
    for (const row of rows) {
      // All-zero migrated rows carry no usable metadata; skip instead of
      // fabricating an epoch timestamp.
      if (!row.updated_at && !row.created_at && !row.title) continue;
      const prev = st.index.get(row.task_id);
      if (prev && prev === row.updated_at) continue;
      st.index.set(row.task_id, row.updated_at);
      // Terminal task_status is metadata only; it never sets a live state.
      out.push({ t: 'meta', sid: row.task_id, at: row.updated_at > 0 ? row.updated_at : 1,
        title: row.title || undefined,
        project: row.workspace_path || undefined,
        model: row.model || undefined,
        startedAt: row.created_at > 0 ? row.created_at : undefined });
    }
    return out;
  });
}

export default {
  id: 'zcode', label: 'ZCode', kind: 'sqlite',
  capabilities: ['state','tools','tokens','turns','title','tasks'],
  roots: home => [path.join(home, '.zcode', 'cli', 'db', 'db.sqlite'), path.join(home, '.zcode', 'v2', 'tasks-index.sqlite')],
  match: file => /(?:^|[\\/])db\.sqlite$|(?:^|[\\/])tasks-index\.sqlite$/.test(file),
  kindOf: () => 'sqlite',
  sessionIdOf: file => path.basename(file),

  async poll(ctx) {
    if (path.basename(ctx.file) === 'tasks-index.sqlite') return pollTaskIndex(ctx);
    return pollDb(ctx);
  },
};
