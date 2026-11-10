// Same reliable call id must count once when output precedes item_completed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import codex from '../src/adapters/codex.js';
import { Store } from '../src/store.js';

test('同 id 开始→输出→完成摘要：失败和重复结果均只计一次', () => {
  const now = Date.now();
  const store = new Store({ privacy: 'titles', detail: 'basic', visibleIdleMin: 30,
    maxSessions: 12, staleSec: 90, toolStaleSec: 900, adapters: {} }, () => now);
  const ctx = { file: 'rollout-synthetic.jsonl', state: {}, shared: {}, detail: 'basic',
    now: () => now, fail() {} };
  const send = (type, payload) => {
    for (const signal of codex.onRecord({ type, payload, timestamp: new Date(now).toISOString() }, ctx) ?? []) {
      store.apply(codex, signal);
    }
  };
  try {
    send('session_meta', { id: 'synthetic' });
    send('event_msg', { type: 'task_started' });
    send('response_item', { type: 'function_call', call_id: 'call-A', name: 'shell', arguments: '{}' });
    send('response_item', { type: 'function_call_output', call_id: 'call-A', output: '{"exit_code":1}' });
    send('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'call-A', exit_code: 1, status: 'failed' } });
    const session = store.entries.get('codex:synthetic').session;
    assert.equal(session.toolCalls, 1, 'completed output and same-id item are one call');
    assert.equal(session.toolErrors, 1, 'one failed call is one failure');
    send('response_item', { type: 'function_call_output', call_id: 'call-A', output: '{"exit_code":1}' });
    assert.equal(session.toolErrors, 1, 're-logged output does not increment failures');
    send('response_item', { type: 'function_call', call_id: 'call-B', name: 'shell', arguments: '{}' });
    send('response_item', { type: 'function_call_output', call_id: 'call-B', output: '{"exit_code":0}' });
    send('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'call-B', exit_code: 0, status: 'completed' } });
    assert.equal(session.toolCalls, 2, 'a distinct call id remains distinct');
    assert.equal(session.toolErrors, 1);
    assert.equal(session.currentTool, null);
  } finally {
    store.close();
  }
});
