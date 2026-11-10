// personal-halo WorkBuddy adapter (new implementation; no upstream
// equivalent). Sources, verified read-only in the A-phase audit:
// 1. ~/.workbuddy/workbuddy.db — sessions metadata (title/custom_title, cwd,
//    model, context_window, timestamps; deleted rows excluded) and
//    session_usage (used/size). Per the revised design the used/size pair is
//    surfaced as context occupancy only; its unit semantics stay gated for
//    display until live confirmation. Running requires an explicit recent
//    sessions.status='working' row (verified on this machine 2026-11-08);
//    database recency alone and residual task snapshots never prove running.
// 2. ~/.workbuddy/tasks/<session-id>/<n>.json — step snapshot files
//    {subject, activeForm, status, id, createdAt, updatedAt}. They are an
//    auxiliary source: they may only enrich sessions discovered from the DB,
//    the per-session list is assembled across files, and a session that has
//    ended keeps its residual in_progress steps (snapshot semantics).
// description and any account/plugin fields are never read into signals.
import path from 'node:path';
import { readSQLite } from '../util/sqlite.js';
import { taskStatus } from '../util/sanitize.js';

const SESSION_LIMIT = 32;

async function pollDb(ctx) {
  return readSQLite(ctx.file, db => {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (!tables.has('sessions')) { ctx.fail('SchemaUnsupported'); return []; }
    const st = ctx.state;
    st.sessions ??= new Map();
    st.statuses ??= new Map();
    st.usage ??= new Map();
    const out = [];
    const rows = db.prepare(
      `SELECT id, cwd, title, custom_title, status, model, context_window,
              created_at, updated_at, last_activity_at
       FROM sessions WHERE deleted_at IS NULL ORDER BY COALESCE(last_activity_at, updated_at) DESC
       LIMIT ${SESSION_LIMIT}`).all();
    const alive = new Set();
    for (const row of rows) {
      alive.add(row.id);
      const stamp = `${row.updated_at}:${row.last_activity_at}:${row.status}:${row.title}:${row.custom_title}:${row.model}`;
      const prev = st.sessions.get(row.id);
      if (prev === stamp) continue;
      st.sessions.set(row.id, stamp);
      const previousStatus = st.statuses.get(row.id);
      st.statuses.set(row.id, row.status);
      const at = Math.max(row.last_activity_at ?? 0, row.updated_at ?? 0);
      out.push({ t: 'meta', sid: row.id, at: at > 0 ? at : 1,
        title: row.custom_title || row.title || undefined,
        project: row.cwd || undefined,
        model: row.model || undefined,
        startedAt: row.created_at > 0 ? row.created_at : undefined });
      if (row.status === 'working' && at >= ctx.now() - 90000 && at <= ctx.now() + 5000) {
        // Coarse execution evidence only: this does not invent a tool or stream.
        out.push({ t: 'thinking', sid: row.id, at });
      } else if (previousStatus === 'working' && ['completed', 'terminated'].includes(row.status)) {
        out.push({ t: 'turn_end', sid: row.id, at: Math.max(at, 1), ok: true });
      }
    }
    for (const sid of [...st.sessions.keys()]) if (!alive.has(sid)) { st.sessions.delete(sid); st.statuses.delete(sid); }

    // Context occupancy pair (unit semantics: pending live confirmation).
    for (const row of db.prepare(`SELECT session_id, used, size, updated_at FROM session_usage`).all()) {
      if (!alive.has(row.session_id)) continue;
      const prev = st.usage.get(row.session_id);
      if (prev && prev.used === row.used && prev.size === row.size) continue;
      st.usage.set(row.session_id, { used: row.used, size: row.size });
      out.push({ t: 'context', sid: row.session_id, at: Math.max(row.updated_at ?? 1, 1), used: row.used, window: row.size });
    }
    return out;
  });
}

// Task snapshot files aggregate per session across separate json files.
function onTaskDocument(doc, cursor, ctx) {
  if (!doc || typeof doc !== 'object' || typeof doc.status !== 'string' || typeof doc.subject !== 'string') {
    return { signals: [], cursor };
  }
  if (cursor === doc.updatedAt) return { signals: [], cursor };
  const sid = ctx.state.sid ?? this.sessionIdOf(ctx.file);
  // Auxiliary semantics: task files only enrich sessions discovered from the
  // DB; they never fabricate sessions on their own.
  if (!ctx.hasSession(sid)) return { signals: [], cursor };
  const shared = ctx.shared;
  shared.tasks ??= new Map();
  const perSession = shared.tasks.get(sid) ?? new Map();
  perSession.set(path.basename(ctx.file), {
    order: typeof doc.id === 'number' ? doc.id : Number(path.basename(ctx.file, '.json')) || 0,
    text: doc.activeForm && doc.status === 'in_progress' ? doc.activeForm : doc.subject,
    status: taskStatus(doc.status),
  });
  shared.tasks.set(sid, perSession);
  const items = [...perSession.values()].sort((a, b) => a.order - b.order)
    .map(i => ({ text: i.text, status: i.status })).filter(i => i.status);
  const signals = items.length ? [{ t: 'tasks', sid, at: Math.max(doc.updatedAt ?? 1, 1), items }] : [];
  return { signals, cursor: doc.updatedAt };
}

export default {
  id: 'workbuddy', label: 'WorkBuddy', kind: 'sqlite',
  capabilities: ['state','tokens','context','title','tasks'],
  roots: home => [path.join(home, '.workbuddy', 'workbuddy.db'), path.join(home, '.workbuddy', 'tasks')],
  match: file => /(?:^|[\\/])workbuddy\.db$|(?:^|[\\/])tasks[\\/].+[\\/]\d+\.json$/i.test(file),
  auxiliary: file => /\.json$/i.test(file),
  kindOf: file => /\.json$/i.test(file) ? 'json-doc' : 'sqlite',
  sessionIdOf: file => path.basename(path.dirname(file)),

  async poll(ctx) {
    return pollDb(ctx);
  },

  onDocument(doc, cursor, ctx) {
    return onTaskDocument.call(this, doc, cursor, ctx);
  },
};
