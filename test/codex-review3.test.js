// Codex review round 3 regressions (audit/Codex-B阶段二次复审.md #1):
// identical commands must never merge two distinct tool calls; only a
// reliable id (item.id === call_id) links a completion item to a started
// call; unlinked completion evidence is always kept; same-id dual-channel
// duplicates count once in both arrival orders; failures are never lost.
// Counts follow the documented口径: paired calls by call_id, unlinked
// completions by item id, one observation per id.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const codex = (await import('../src/adapters/codex.js')).default;
import { Store } from '../src/store.js';
import { Watcher } from '../src/watch.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
// fixture 时间戳相对当前时间生成：绝对日期会随真实时间推进过期出 10h 可见窗口
const FIX = minsAgo => new Date(Date.now() - minsAgo * 60000).toISOString();

const A = '0d100000-0000-4000-8000-0000000000d1';
const B = '0d200000-0000-4000-8000-0000000000d2';
const C = '0d300000-0000-4000-8000-0000000000d3';
const D = '0d400000-0000-4000-8000-0000000000d4';
const E = '0d500000-0000-4000-8000-0000000000d5';

let home;
async function makeConfig() {
  return {
    privacy: 'titles', detail: 'basic', visibleIdleMin: 600, maxSessions: 12,
    staleSec: 90, toolStaleSec: 900,
    adapters: { codex: { enabled: true, roots: [path.join(home, '.codex', 'sessions')] } },
  };
}
function datedDir(root, daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
}
async function startWatcher(config) {
  const store = new Store(config);
  const watcher = new Watcher([codex], store, config);
  await watcher.start(false);
  return { store, watcher };
}
const session = (store, sid) => store.entries.get(`codex:${sid}`)?.session;
const discoverAll = async watcher => {
  for (const slot of watcher.roots) await watcher.discover(slot.owner, slot.root);
  await Promise.all([...watcher.files.values()].map(entry => watcher.read(entry)));
  await sleep(200);
};

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'personal-halo-codex-r3-'));
  await mkdir(datedDir(path.join(home, '.codex', 'sessions')), { recursive: true });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const item = (id, exit) => ({ type: 'item_completed', thread_id: 'x', turn_id: 't1',
  started_at_ms: 1, completed_at_ms: 2, item: { type: 'CommandExecution', id, command: ['bash', '-lc', 'npm test'], exit_code: exit, status: 'completed' } });
const call = id => JSON.stringify({ timestamp: FIX(44), type: 'response_item', payload: { type: 'function_call', id, call_id: id, name: 'shell', input: '{"command":["bash","-lc","npm test"]}' } });
const callOut = (id, exit = 0) => JSON.stringify({ timestamp: FIX(44), type: 'response_item', payload: { type: 'function_call_output', id: id + '-out', call_id: id, output: '{"exit_code":' + exit + '}' } });
const head = sid => JSON.stringify({ timestamp: FIX(44), type: 'session_meta', payload: { id: sid, cwd: 'C:/private/demo' } });
const turn = (on, off) => [JSON.stringify({ timestamp: FIX(44), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', model_context_window: 128000 } }), ...(off ? [JSON.stringify({ timestamp: FIX(44), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } })] : [])];

test('同轮相同命令两次执行：两次都保留，第二次失败不丢（未关联口径）', async () => {
  const today = datedDir(path.join(home, '.codex', 'sessions'));
  await writeFile(path.join(today, `rollout-2026-11-07T09-06-00-${A}.jsonl`),
    [head(A), ...turn(true, false),
      JSON.stringify({ timestamp: FIX(44), type: 'event_msg', payload: item('item-A', 0) }),
      call('k-B'), callOut('k-B', 1),
      ...turn(true, true)].join('\n') + '\n');
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const s = session(store, A);
  const dbgFile = path.join(datedDir(path.join(home, '.codex', 'sessions')), `rollout-2026-11-07T09-06-00-${A}.jsonl`);
  const dbgStat = await (await import('node:fs/promises')).stat(dbgFile).then(r => ({ size: r.size, mtime: r.mtimeMs }), e => 'missing');
  const dbgRead = typeof dbgStat === 'object' ? (await (await import('node:fs/promises')).readFile(dbgFile, 'utf8')).split('\n').length : dbgStat;
  console.error('[dbg]', JSON.stringify({ dbgStat, dbgRead, watching: watcher.health()[0].watching, parse: watcher.health()[0].parseErrors, entries: [...store.entries.keys()], lines: globalThis.__haloLines ?? 0, lastLine: globalThis.__haloLastLine ?? '' }));
  assert.equal(s.toolCalls, 2, 'unlinked completion A + paired call B both counted');
  assert.equal(s.toolErrors, 1, 'second invocation failure evidence kept');
  await watcher.close(); store.close();
});

test('并行相同命令：完成项不猜归属，不闭合另一调用', async () => {
  const today = datedDir(path.join(home, '.codex', 'sessions'));
  await writeFile(path.join(today, `rollout-2026-11-07T09-07-00-${B}.jsonl`),
    [head(B), ...turn(true, false),
      call('k-A'), call('k-B'),
      JSON.stringify({ timestamp: FIX(45), type: 'event_msg', payload: item('item-A', 0) }),
      callOut('k-A'), callOut('k-B'),
      ...turn(true, true)].join('\n') + '\n');
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const s = session(store, B);
  assert.equal(s.toolCalls, 3, 'two paired calls + one unlinked completion, no guessed merge');
  assert.equal(s.currentTool, null, 'both calls closed by their own outputs');
  await watcher.close(); store.close();
});

test('同 id 双通道（item.id === call_id）：先 call 后 item 只计一次', async () => {
  const today = datedDir(path.join(home, '.codex', 'sessions'));
  await writeFile(path.join(today, `rollout-2026-11-07T09-08-00-${C}.jsonl`),
    [head(C), ...turn(true, false),
      call('same-id'),
      JSON.stringify({ timestamp: FIX(46), type: 'event_msg', payload: item('same-id', 0) }),
      callOut('same-id'),
      ...turn(true, true)].join('\n') + '\n');
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const s = session(store, C);
  assert.equal(s.toolCalls, 1, 'reliable id correlation: counted once');
  assert.equal(s.toolErrors, 0);
  await watcher.close(); store.close();
});

test('同 id 双通道：item 先到也只计一次，后到开始被抑制', async () => {
  const today = datedDir(path.join(home, '.codex', 'sessions'));
  await writeFile(path.join(today, `rollout-2026-11-07T09-09-00-${D}.jsonl`),
    [head(D), ...turn(true, false),
      JSON.stringify({ timestamp: FIX(47), type: 'event_msg', payload: item('same-id-2', 1) }),
      call('same-id-2'), callOut('same-id-2'),
      ...turn(true, true)].join('\n') + '\n');
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const s = session(store, D);
  assert.equal(s.toolCalls, 1, 'item-first arrival counted once');
  assert.equal(s.toolErrors, 1, 'failure evidence kept exactly once');
  await watcher.close(); store.close();
});

test('连续同名 MCP 调用参数不同：不因工具名相同而闭合彼此', async () => {
  const today = datedDir(path.join(home, '.codex', 'sessions'));
  await writeFile(path.join(today, `rollout-2026-11-07T09-10-00-${E}.jsonl`),
    [head(E), ...turn(true, false),
      call('m1'), call('m2'),
      JSON.stringify({ timestamp: FIX(48), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'x', turn_id: 't1', started_at_ms: 5, completed_at_ms: 6, item: { type: 'McpToolCall', id: 'mi1', server: 'srv', tool: 'query', arguments: { a: 1 }, status: 'completed' } } }),
      callOut('m1'), callOut('m2'),
      ...turn(true, true)].join('\n') + '\n');
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const s = session(store, E);
  assert.equal(s.toolCalls, 3, 'two calls + one unlinked McpToolCall completion');
  assert.ok(s.recentTools.filter(t => t.ok === true).length >= 2, 'both calls end by their own outputs');
  await watcher.close(); store.close();
});
