// personal-halo Codex adapter. Signal mapping is derived from agent-halo
// (commit 4a22a69c6ad9) collector/src/adapters/codex.js under PolyForm
// Noncommercial 1.0.0, extended per audit/Codex-A阶段复核.md and
// audit/Codex-B阶段审查与修订任务.md:
// - Three sources merged by session id: schema-checked state_*.sqlite
//   threads/thread_spawn_edges metadata, session_index.jsonl discovery and
//   titles, recent rollout JSONL events. None is exclusive; a partially
//   available source never suppresses discovery of recent rollouts.
// - Parent linkage: top-level payload.parent_thread_id first, then the
//   confirmed nested source.subagent.thread_spawn.parent_thread_id.
// - Token accounting: token_usage_record.thread_token_usage is the primary
//   cumulative channel; token_count only supplies context metadata unless the
//   primary channel has not appeared yet (fallback). Cumulative readings are
//   completion backfills — the store never derives a streaming rate from them.
// - Tool correlation across channels: a completion item (item_completed) is
//   joined to a response_item call only when item.id equals call_id, including
//   calls whose output was already observed. Everything that cannot be
//   proven identical is kept as its own completed tool — never dropped.
// - Explicit record classification at every nesting level: understood-but-
//   unused types count as ignoredRecords; unrecognized types count as
//   unknownRecords and are never swallowed.
// Privacy: no message content, reasoning, tool output, or account fields are
// read; thread first_user_message is deliberately not projected.
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { readSQLite } from '../util/sqlite.js';
import { clean, timestamp, textSnippet } from '../util/sanitize.js';
import { extractToolTarget, extractTasks, codexToolOK } from '../util/target.js';

const THREAD_LIMIT = 32;
const USAGE_DEDUP_CAP = 1024;

function newestStateDb(home) {
  let best = null;
  let bestMtime = -1;
  try {
    for (const name of readdirSync(path.join(home, '.codex'))) {
      if (!/^state_\d+\.sqlite$/.test(name)) continue;
      const full = path.join(home, '.codex', name);
      try {
        const mtime = statSync(full).mtimeMs;
        if (mtime > bestMtime) { bestMtime = mtime; best = full; }
      } catch { /* unreadable entry: skip */ }
    }
  } catch { /* no .codex directory */ }
  return best;
}

// Cross-channel correlation rule (audit/Codex-B阶段二次复审.md #1): a
// completion item is linked to a started call ONLY when the reliable key
// matches exactly (item.id === call_id). Identical commands or tool names are
// at best candidates and never delete events or close another call. Unlinked
// completions stay as their own completed tools (callId `item:<id>`), counted
// once per item id in both arrival orders; failures are never lost.
function resetTurnTracking(state) {
  state.openCalls = new Map();    // callId -> name (open response_item calls)
  state.endedByItem = new Set();  // callIds closed by an id-matched item
  state.suppressed = new Set();   // callIds whose start was suppressed
  // state.seenItemIds / state.countedItemIds persist across turns (per file).
}

export default {
  id: 'codex', label: 'Codex', kind: 'jsonl', dated: true,
  capabilities: ['state','tools','tokens','context','turns','title','tasks'],
  roots: home => {
    const roots = [path.join(home, '.codex', 'sessions'), path.join(home, '.codex', 'session_index.jsonl')];
    const db = newestStateDb(home);
    if (db) roots.push(db);
    return roots;
  },
  match: file => /(?:rollout-.*\.jsonl|session_index\.jsonl|state_\d+\.sqlite)$/.test(file),
  auxiliary: file => path.basename(file) === 'session_index.jsonl',
  kindOf: file => file.endsWith('.sqlite') ? 'sqlite' : 'jsonl',
  sessionIdOf: file => path.basename(file).match(/([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\.jsonl$/i)?.[1] ?? path.basename(file, '.jsonl'),

  async poll(ctx) {
    return readSQLite(ctx.file, db => {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
      if (!tables.has('threads')) { ctx.fail('SchemaUnsupported'); return []; }
      const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map(c => c.name));
      const pick = name => cols.has(name) ? `"${name}"` : `NULL AS "${name}"`;
      const order = cols.has('updated_at_ms') ? 'updated_at_ms DESC' : 'updated_at DESC';
      const where = cols.has('archived') ? 'WHERE archived = 0' : '';
      const rows = db.prepare(
        `SELECT ${['id','title','name','model','cwd','source','created_at_ms','updated_at_ms'].map(pick).join(', ')}
         FROM threads ${where} ORDER BY ${order} LIMIT ${THREAD_LIMIT}`).all();
      const edges = tables.has('thread_spawn_edges')
        ? db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges').all()
        : [];
      const parentOf = new Map(edges.map(e => [e.child_thread_id, e.parent_thread_id]).filter(([p, c]) => p && c));
      const seen = ctx.state.sqliteSeen ??= new Map();
      const out = [];
      for (const row of rows) {
        const sid = row.id;
        if (!sid) continue;
        const stamp = row.updated_at_ms;
        if (seen.get(sid) === stamp) continue;
        seen.set(sid, stamp);
        const at = typeof stamp === 'number' ? stamp : ctx.now();
        // Documented priority: top-level parent_thread_id, then the nested
        // thread_spawn record, then thread_spawn_edges.
        let parentSid = row.parent_thread_id ?? undefined;
        if (!parentSid && typeof row.source === 'string' && row.source.startsWith('{')) {
          try { parentSid = JSON.parse(row.source)?.subagent?.thread_spawn?.parent_thread_id ?? undefined; } catch { /* free text */ }
        }
        if (!parentSid) parentSid = parentOf.get(sid);
        out.push({ t: 'meta', sid, at,
          title: row.title ?? row.name ?? undefined,
          project: row.cwd ?? undefined,
          model: row.model ?? undefined,
          parentSid,
          startedAt: typeof row.created_at_ms === 'number' ? row.created_at_ms : undefined });
      }
      return out;
    });
  },

  onRecord(rec, ctx) {
    if (this.auxiliary(ctx.file)) {
      // Session discovery + titles. Rows lacking the expected shape are
      // ignored, not treated as unknown types.
      if (!rec.id || !rec.updated_at) return [];
      if (typeof rec.thread_name !== 'string') return [];
      const at = timestamp(rec.updated_at, ctx.now);
      return [{ t: 'meta', sid: rec.id, title: rec.thread_name, at, startedAt: at }];
    }
    const p = rec.payload;
    const at = timestamp(rec.timestamp, ctx.now);
    if (rec.type === 'session_meta') ctx.state.sid = p?.id;
    const sid = ctx.state.sid ?? this.sessionIdOf(ctx.file);
    const st = ctx.state;
    if (!st.openCalls) resetTurnTracking(st);
    st.completedCallIds ??= new Set();
    const out = [];
    const add = (t, fields = {}) => out.push({ t, sid, at, ...fields });
    switch (rec.type) {
      case 'session_meta': {
        const nestedParent = p?.source?.subagent?.thread_spawn?.parent_thread_id;
        add('meta', {
          project: p?.cwd,
          parentSid: p?.parent_thread_id ?? nestedParent,
          startedAt: at,
          title: ctx.shared.titles?.get(sid),
        });
        break;
      }
      case 'turn_context': add('meta', { model: p?.model }); break;
      case 'token_usage_record': {
        // Primary cumulative channel; response_id dedup guards re-logged rows.
        if (typeof p?.response_id === 'string') {
          const seen = st.usageResponses ??= new Set();
          if (seen.has(p.response_id)) return [];
          if (seen.size >= USAGE_DEDUP_CAP) seen.clear();
          seen.add(p.response_id);
        }
        const u = p?.thread_token_usage;
        if (!u) return []; // per-turn usage only: not a cumulative source, not unknown.
        st.tokenChannel = 'thread_usage';
        add('tokens', { input: u.input_tokens, output: u.output_tokens, reasoning: u.reasoning_output_tokens,
          cacheRead: u.cached_input_tokens, total: u.total_tokens, mode: 'cumulative' });
        break;
      }
      case 'event_msg':
        switch (p?.type) {
          case 'task_started':
            resetTurnTracking(st);
            add('turn_start');
            if (p.model_context_window) add('context', { window: p.model_context_window });
            break;
          case 'token_count': {
            // Backup/fallback channel: cumulative counts only until the
            // primary channel has been observed in this session file.
            if (st.tokenChannel !== 'thread_usage' && p.info?.total_token_usage) {
              const u = p.info.total_token_usage;
              add('tokens', { input: u.input_tokens, output: u.output_tokens, reasoning: u.reasoning_output_tokens,
                cacheRead: u.cached_input_tokens, total: u.total_tokens, mode: 'cumulative' });
            }
            if (p.info?.last_token_usage) add('context', { used: p.info.last_token_usage.input_tokens, window: p.info.model_context_window });
            break;
          }
          case 'task_complete': add('turn_end', { ok: true }); break;
          case 'turn_aborted': case 'error': case 'stream_error': add('turn_end', { ok: false }); break;
          case 'exec_approval_request': case 'apply_patch_approval_request': add('waiting'); break;
          case 'thread_settings_applied': return []; // settings notification; model changes arrive via turn_context
          case 'item_completed': {
            const item = p?.item;
            const type = item?.type;
            if (type === 'ContextCompaction') { add('compact'); break; }
            if (type === 'CommandExecution' || type === 'McpToolCall' || type === 'WebSearch' || type === 'DynamicToolCall') {
              const seen = st.seenItemIds ??= new Set();
              const counted = st.countedItemIds ??= new Set();
              const id = typeof item?.id === 'string' ? item.id : null;
              // Re-logged completion (same item id) counts once.
              if (id && seen.has(id)) return [];
              if (id) seen.add(id);
              if (id && st.completedCallIds.has(id)) return [];
              const ok = type === 'CommandExecution'
                ? !(item.exit_code > 0 || item.status === 'failed')
                : item.status !== 'failed';
              // Reliable correlation: item.id equals an open call's call_id.
              if (id && st.openCalls.has(id)) {
                st.endedByItem.add(id);
                st.openCalls.delete(id);
                add('tool_end', { callId: id, ok });
                break;
              }
              // Unlinked completion: its own observation, never merged by
              // command or tool-name similarity, never suppressing later calls.
              if (id && counted.has(id)) return []; // item arrived first, start already suppressed
              if (id) counted.add(id);
              const atomicId = `item:${id ?? `${type}:${p.completed_at_ms ?? ''}`}`;
              const startedAt = typeof p.started_at_ms === 'number' ? p.started_at_ms : at;
              const endedAt = typeof p.completed_at_ms === 'number' ? p.completed_at_ms : at;
              add('tool_start', { callId: atomicId, at: startedAt, tool: type === 'CommandExecution' ? 'exec' : item.tool ?? type });
              add('tool_end', { callId: atomicId, at: endedAt, ok });
              break;
            }
            if (['Reasoning','AgentMessage','UserMessage','FileChange','ImageView','Extension','SubAgentActivity'].includes(type)) return [];
            return null; // unknown item.type → unknownRecords
          }
          default: return null; // unknown event_msg payload type
        }
        break;
      case 'response_item':
        switch (p?.type) {
          case 'reasoning': add('thinking'); break;
          case 'message':
            if (p.role === 'assistant') {
              if (ctx.detail === 'full') {
                const text = typeof p.content === 'string' ? p.content : p.content?.findLast(b => b.type === 'output_text')?.text;
                add('text', { snippet: textSnippet(text) });
              } else add('text');
            }
            break;
          case 'custom_tool_call': case 'function_call': case 'local_shell_call': case 'web_search_call': {
            const tool = p.name ?? p.type;
            const args = p.arguments ?? p.input ?? p.action;
            // Reversed order with a reliable id: the completion item already
            // counted this call, so its start and output are suppressed.
            if (p.call_id && (st.countedItemIds?.has(p.call_id) || st.suppressed.has(p.call_id) || st.completedCallIds.has(p.call_id))) {
              st.suppressed.add(p.call_id);
              break;
            }
            add('tool_start', { tool, callId: p.call_id, ...extractToolTarget(tool, args, ctx.detail, ctx.fail) });
            const items = extractTasks(tool, args, ctx.fail);
            if (items) add('tasks', { items });
            if (p.call_id) st.openCalls.set(p.call_id, tool);
            break;
          }
          case 'custom_tool_call_output': case 'function_call_output':
            if (st.endedByItem.has(p.call_id) || st.suppressed.has(p.call_id) || st.completedCallIds.has(p.call_id)) return [];
            add('tool_end', { callId: p.call_id, ok: codexToolOK(p.output) });
            if (p.call_id) st.completedCallIds.add(p.call_id);
            st.openCalls.delete(p.call_id);
            break;
          case 'agent_message': case 'additional_tools': case 'compaction': return [];
          default: return null; // unknown response_item payload type
        }
        break;
      case 'world_state': case 'inter_agent_communication_metadata': return [];
      default: return null; // unknown top-level type
    }
    return out;
  },
};
