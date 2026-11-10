// Copied from agent-halo (commit 4a22a69c6ad9) collector/src/adapters/dsh.js
// under PolyForm Noncommercial 1.0.0; field mapping verified against probed
// v4 records by that project. See personal-halo/NOTICE.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { taskStatus, textSnippet } from '../util/sanitize.js';
import { extractToolTarget } from '../util/target.js';

export default {
  id: 'dsh', label: 'DeepSeek Harness', kind: 'zstd-jsonl',
  capabilities: ['state','tools','tokens','context','turns','title','tasks'],
  roots: home => [path.join(home, '.dsh', 'sessions')],
  match: file => /session(?:\.v4)?\.jsonl\.zstd$/.test(file),
  prefer: file => file.endsWith('session.v4.jsonl.zstd') || !existsSync(path.join(path.dirname(file), 'session.v4.jsonl.zstd')),
  sessionIdOf: file => path.basename(path.dirname(file)).replace(/^session-/, ''),

  onRecord(rec, ctx) {
    if (rec.type === 'session') ctx.state.sid = rec.id;
    const sid = ctx.state.sid ?? this.sessionIdOf(ctx.file);
    const at = rec.time ?? rec.createdAt ?? ctx.now();
    const data = rec.data;
    const out = [];
    const add = (t, fields = {}) => out.push({ t, sid, at, ...fields });
    // These two dedicated projections are unambiguous in the probed v4 records.
    if (data?.todos) {
      add('tasks', { items: data.todos.map(i => ({ text: i.content, status: taskStatus(i.status) })).filter(i => i.status) });
      return out;
    }
    if (data?.model && data?.contextWindow) {
      add('meta', { model: data.model }); add('context', { window: data.contextWindow });
      return out;
    }
    switch (rec.type) {
      case 'session': add('meta', { project: rec.cwd, startedAt: at }); break;
      case 'session/title': add('meta', { title: data?.title }); break;
      case 'turn/start': add('turn_start'); break;
      case 'step/start': add('thinking'); break;
      case 'user/message': case 'step/end': return [];
      case 'assistant/message': {
        if (data?.message?.source?.model) add('meta', { model: data.message.source.model });
        for (const b of data?.message?.content ?? []) {
          if (b.type === 'reasoning') add('thinking');
          if (b.type === 'text') add('text', ctx.detail === 'full' ? { snippet: textSnippet(b.text) } : {});
        }
        const u = data?.usage;
        if (u) {
          add('tokens', { mode: 'delta', input: u.inputTokens, output: u.outputTokens, reasoning: u.reasoningTokens, cacheRead: u.cacheReadTokens, total: u.totalTokens });
          if (u.inputTokens != null) add('context', { used: u.inputTokens + (u.cacheReadTokens ?? 0) });
        }
        break;
      }
      case 'tool/call': add('tool_start', { tool: data?.name, callId: data?.callId, ...extractToolTarget(data?.name, data?.arguments, ctx.detail, ctx.fail) }); break;
      case 'tool/result': add('tool_end', { callId: data?.message?.toolCallId, ok: !data?.message?.isError }); break;
      case 'turn/end': add('turn_end', { ok: data?.reason?.kind === 'completed' }); break;
      default: return null;
    }
    return out;
  },
};
