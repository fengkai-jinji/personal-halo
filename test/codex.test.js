// Codex adapter tests: synthetic fixtures only (PRIVATE_SYNTHETIC_* markers),
// never real user data. Covers the revised-design boundaries: token primary/
// fallback channels without double counting, response_id dedup, callId pairing
// with parallel tools, explicit record classification (ignored/unknown/parse
// errors), parent linkage from session_meta.source and thread_spawn_edges,
// SQLite merge/fallback with WAL updates, dated discovery, tail reading,
// truncation, and the Codex-B阶段审查 round-2 regressions (nested-only parent,
// unknown subtypes at every level, mixed-channel tool correlation).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const codex = (await import('../src/adapters/codex.js')).default;
import { Store } from '../src/store.js';
import { Watcher } from '../src/watch.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
// fixture 时间戳相对当前时间生成：绝对日期会随真实时间推进过期出 10h 可见窗口
const FIX = minsAgo => new Date(Date.now() - minsAgo * 60000).toISOString();


const PARENT = '0aa00000-0000-4000-8000-0000000000aa';
const CHILD = '0bb00000-0000-4000-8000-0000000000bb';
const BIG = '0ba00000-0000-4000-8000-0000000000ba';
const PARALLEL = '0ab00000-0000-4000-8000-0000000000ab';
const TRUNC = '0fa00000-0000-4000-8000-0000000000fa';
const DD = '0dd00000-0000-4000-8000-0000000000dd';
const EE = '0ee00000-0000-4000-8000-0000000000ee';
const CC = '0cc00000-0000-4000-8000-0000000000cc';
const FF = '0ff00000-0000-4000-8000-0000000000ff';
const NESTED = '0c100000-0000-4000-8000-0000000000c1';
const CONFLICT = '0c200000-0000-4000-8000-0000000000c2';
const UNK = '0c300000-0000-4000-8000-0000000000c3';
const SAMECALL = '0c400000-0000-4000-8000-0000000000c4';
const INDEP = '0c500000-0000-4000-8000-0000000000c5';
const REVERSED = '0c600000-0000-4000-8000-0000000000c6';

let home;
async function makeConfig(extra = {}) {
  const sessionsDir = path.join(home, '.codex', 'sessions');
  const indexFile = path.join(home, '.codex', 'session_index.jsonl');
  const dbFile = path.join(home, '.codex', 'state_5.sqlite');
  const roots = [sessionsDir, indexFile];
  if (existsSync(dbFile)) roots.push(dbFile);
  return {
    privacy: 'titles', detail: 'basic', visibleIdleMin: 600, maxSessions: 12,
    staleSec: 90, toolStaleSec: 900,
    adapters: { codex: { enabled: true, roots, ...extra } },
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
const health = watcher => watcher.health()[0];
const discoverAll = async watcher => {
  for (const slot of watcher.roots) await watcher.discover(slot.owner, slot.root);
  // live=false has no fs.watch; force a read pass so mtime/size changes are seen.
  await Promise.all([...watcher.files.values()].map(entry => watcher.read(entry)));
  await sleep(200);
};

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'personal-halo-codex-'));
  const today = datedDir(path.join(home, '.codex', 'sessions'));
  await mkdir(today, { recursive: true });
  const fixtures = path.resolve('test/fixtures/codex');
  // fixture 文件内时间戳按顺序重写为最近时间（相对 now），避免绝对日期过期出可见窗口
  let seq = 0;
  const reTimestamp = /2026-11-0\dT\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
  const freshen = async (src, dst) => {
    const raw = await (await import('node:fs/promises')).readFile(src, 'utf8');
    const fixed = raw.replace(reTimestamp, () => new Date(Date.now() - 30 * 60000 + (seq++) * 1000).toISOString());
    await writeFile(dst, fixed);
  };
  await freshen(path.join(fixtures, 'rollout-parent.jsonl'), path.join(today, `rollout-2026-11-07T08-00-00-${PARENT}.jsonl`));
  await freshen(path.join(fixtures, 'rollout-child.jsonl'), path.join(today, `rollout-2026-11-07T08-01-00-${CHILD}.jsonl`));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

test('rollout 事件映射、token 主/备通道、response_id 去重、记录分类', async () => {
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);

  const s = session(store, PARENT);
  assert.ok(s, 'session created from rollout');
  assert.equal(s.project, 'demo');
  // 未关联口径：call_a/call_b 按 call_id 配对；item_1 与 call_a 无可靠 id 关联
  // （item.id ≠ call_id），保留为独立完成观察 → 2 配对 + 1 未关联 = 3。
  assert.equal(s.toolCalls, 3, 'call_a + call_b paired; item_1 kept as unlinked completion');
  assert.equal(s.toolErrors, 1, 'call_b exit_code=1 counted failed');
  assert.equal(s.recentTools.find(t => t.name === 'shell').target, 'npm test');
  // Primary channel: thread_token_usage wins; the later token_count cumulative
  // (999/1500) must NOT overwrite; the duplicate response_id must not apply.
  assert.deepEqual(
    { input: s.tokens.input, output: s.tokens.output, reasoning: s.tokens.reasoning, cacheRead: s.tokens.cacheRead, total: s.tokens.total },
    { input: 200, output: 30, reasoning: 5, cacheRead: 80, total: 235 });
  // Backup channel still supplies context metadata (window + last input).
  assert.equal(s.context.window, 400000);
  assert.equal(s.context.used, 200);
  // Cumulative channel data never fabricates a streaming rate.
  assert.equal(s.tps, null);
  // Explicit classification on this fixture: 1 broken JSON line, 1 unknown
  // top-level type; the CommandExecution item shares call_a's exact command,
  // so it closes call_a instead of counting a second tool.
  const h = health(watcher);
  assert.equal(h.parseErrors, 1);
  assert.equal(h.unknownRecords, 1);
  await watcher.close(); store.close();
});

test('真实父子 id：session_meta.source.thread_spawn → parentKey', async () => {
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const child = session(store, CHILD);
  assert.ok(child);
  assert.equal(child.parentKey, `codex:${PARENT}`);
  await watcher.close(); store.close();
});

test('SQLite threads 元数据合并：thread_spawn_edges 父子、archived 排除、标题补充', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dbFile = path.join(home, '.codex', 'state_5.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, model TEXT, cwd TEXT,
    source TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, archived INTEGER DEFAULT 0);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
    INSERT INTO threads (id, title, name, model, cwd, source, created_at_ms, updated_at_ms, archived) VALUES
      ('${PARENT}', 'SQLite 标题甲', null, 'gpt-6.1-sol', 'C:/private/proj', 'vscode', 1000, 9000, 0),
      ('${CHILD}', null, '守护复查', null, 'C:/private/proj', '{"subagent":{"thread_spawn":{"parent_thread_id":"${PARENT}","depth":1}}}', 2000, 8000, 0),
      ('${CC}', '已归档', null, null, null, null, 3000, 9500, 1);
    INSERT INTO thread_spawn_edges VALUES ('${PARENT}', '${CHILD}', 'open');`);
  db.close();

  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const a = session(store, PARENT);
  assert.equal(a.title, 'SQLite 标题甲');
  assert.equal(a.model, 'gpt-6.1-sol');
  const b = session(store, CHILD);
  assert.equal(b.parentKey, `codex:${PARENT}`);
  assert.equal(b.title, '守护复查');
  assert.equal(session(store, CC), undefined, 'archived threads excluded');
  await watcher.close(); store.close();
});

test('SQLite WAL 更新：新增行被增量 poll 发现', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dbFile = path.join(home, '.codex', 'state_5.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, model TEXT, cwd TEXT,
    source TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, archived INTEGER DEFAULT 0);
    INSERT INTO threads (id, title, updated_at_ms) VALUES ('${DD}', '首轮', 1000);`);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  assert.equal(session(store, EE), undefined);

  const db2 = new DatabaseSync(dbFile);
  db2.prepare(`INSERT INTO threads (id, title, updated_at_ms) VALUES ('${EE}', 'WAL 增量', 2000)`).run();
  db2.close();
  await discoverAll(watcher);
  const e = session(store, EE);
  assert.ok(e, 'new thread row discovered via WAL mtime');
  assert.equal(e.title, 'WAL 增量');
  await watcher.close(); store.close();
});

test('schema 不支持：无 threads 表时明确诊断且不崩溃', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(home, '.codex', 'state_5.sqlite'));
  db.exec('CREATE TABLE _sqlx_migrations (id TEXT PRIMARY KEY);');
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const h = health(watcher);
  assert.match(h.lastError ?? '', /SchemaUnsupported/);
  assert.ok(h.sessions >= 0);
  await watcher.close(); store.close();
});

test('无 SQLite 时 rollout 单独可用；session_index 补标题与发现', async () => {
  await writeFile(path.join(home, '.codex', 'session_index.jsonl'),
    `{"id":"${PARENT}","thread_name":"索引补充标题","updated_at":"${FIX(41)}"}\n` +
    `{"id":"${FF}","thread_name":"仅索引会话","updated_at":"${FIX(42)}"}\n`);
  const config = await makeConfig();
  config.adapters.codex.roots = config.adapters.codex.roots.filter(p => !p.endsWith('.sqlite'));
  const { store, watcher } = await startWatcher(config);
  await discoverAll(watcher);
  const s = session(store, PARENT);
  assert.ok(s, 'rollout-only session discovered');
  assert.equal(s.toolCalls, 3, 'two paired calls + one unlinked completion');
  // session_index may create title-only sessions and enrich existing ones.
  const f = session(store, FF);
  assert.equal(f?.title, '仅索引会话');
  assert.ok(Number.isFinite(f.startedAt) || Number.isFinite(f.lastActivity));
  await watcher.close(); store.close();
});

test('8MiB 以上只读尾部：保留首条 session_meta，正文行仍可增量', async () => {
  const today = datedDir(path.join(home, '.codex', 'sessions'));
  // Tail-reading is tested in isolation: the shared fixtures would pollute the
  // per-adapter record counters with their own intentional noise.
  const fsp = await import('node:fs/promises');
  for (const name of await fsp.readdir(today)) await fsp.rm(path.join(today, name));
  const pad = JSON.stringify({ timestamp: FIX(38), type: 'world_state', payload: { state: { blob: 'x'.repeat(4096) } } });
  const lines = [
    JSON.stringify({ timestamp: FIX(38), type: 'session_meta', payload: { id: BIG, cwd: 'C:/private/demo' } }),
    pad.repeat(2300), // ~9.4MB single padding record
    JSON.stringify({ timestamp: FIX(38), type: 'event_msg', payload: { type: 'task_started', turn_id: 't9', model_context_window: 128000 } }),
    JSON.stringify({ timestamp: FIX(38), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't9' } }),
  ];
  await writeFile(path.join(today, `rollout-2026-11-07T08-02-00-${BIG}.jsonl`), lines.join('\n') + '\n');
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const s = session(store, BIG);
  assert.ok(s, 'session kept via first record when skipping history');
  assert.equal(s.turn, 1, 'tail lines processed');
  const h = health(watcher);
  assert.ok(h.unknownRecords === 0 && h.parseErrors === 0, `no parse noise from padding (unknown=${h.unknownRecords}, parse=${h.parseErrors})`);
  await watcher.close(); store.close();
});

test('截断重读：文件变小时重置并重建会话', async () => {
  const today = datedDir(path.join(home, '.codex', 'sessions'));
  const file = path.join(today, `rollout-2026-11-07T08-03-00-${TRUNC}.jsonl`);
  await writeFile(file, [
    JSON.stringify({ timestamp: FIX(39), type: 'session_meta', payload: { id: TRUNC, cwd: 'C:/private/old' } }),
    JSON.stringify({ timestamp: FIX(39), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', model_context_window: 128000 } }),
    JSON.stringify({ timestamp: FIX(39), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }),
  ].join('\n') + '\n');
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  assert.ok(session(store, TRUNC));

  await writeFile(file, [
    JSON.stringify({ timestamp: FIX(39), type: 'session_meta', payload: { id: TRUNC, cwd: 'C:/private/new' } }),
  ].join('\n') + '\n');
  await discoverAll(watcher);
  const s = session(store, TRUNC);
  assert.ok(s, 'session re-created after truncation');
  assert.equal(s.project, 'new');
  assert.equal(s.turn, 0, 'stale turn state reset');
  await watcher.close(); store.close();
});

test('并行工具：同轮多个 callId 各自配对，互不丢失', async () => {
  const today = datedDir(path.join(home, '.codex', 'sessions'));
  await writeFile(path.join(today, `rollout-2026-11-07T08-04-00-${PARALLEL}.jsonl`),
    [
      JSON.stringify({ timestamp: FIX(40), type: 'session_meta', payload: { id: PARALLEL, cwd: 'C:/private/demo' } }),
      JSON.stringify({ timestamp: FIX(40), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', model_context_window: 128000 } }),
      JSON.stringify({ timestamp: FIX(40), type: 'response_item', payload: { type: 'function_call', id: 'p1', call_id: 'p1', name: 'shell', input: '{"command":["bash","-lc","sleep 1"]}' } }),
      JSON.stringify({ timestamp: FIX(40), type: 'response_item', payload: { type: 'function_call', id: 'p2', call_id: 'p2', name: 'shell', input: '{"command":["bash","-lc","sleep 2"]}' } }),
      JSON.stringify({ timestamp: FIX(40), type: 'response_item', payload: { type: 'function_call_output', id: 'o2', call_id: 'p2', output: '{"exit_code":0}' } }),
      JSON.stringify({ timestamp: FIX(40), type: 'response_item', payload: { type: 'function_call_output', id: 'o1', call_id: 'p1', output: '{"exit_code":0}' } }),
      JSON.stringify({ timestamp: FIX(40), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }),
    ].join('\n') + '\n');
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const s = session(store, PARALLEL);
  assert.equal(s.toolCalls, 2);
  assert.ok(s.recentTools.every(t => t.ok === true), 'both parallel calls paired and completed');
  await watcher.close(); store.close();
});

// ---- Codex review round 2 regressions (audit/Codex-B阶段审查与修订任务.md) ----

test('嵌套父链：仅 source.subagent.thread_spawn 时也建立父链；顶层优先', async () => {
  const today = datedDir(path.join(home, '.codex', 'sessions'));
  await writeFile(path.join(today, `rollout-2026-11-07T09-00-00-${NESTED}.jsonl`),
    [
      JSON.stringify({ timestamp: FIX(43), type: 'session_meta', payload: { id: NESTED, cwd: 'C:/private/demo', source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } } } }),
    ].join('\n') + '\n');
  await writeFile(path.join(today, `rollout-2026-11-07T09-01-00-${CONFLICT}.jsonl`),
    [
      JSON.stringify({ timestamp: FIX(44), type: 'session_meta', payload: { id: CONFLICT, cwd: 'C:/private/demo', parent_thread_id: PARENT, source: { subagent: { thread_spawn: { parent_thread_id: CHILD } } } } }),
    ].join('\n') + '\n');
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const nestedOnly = session(store, NESTED);
  assert.equal(nestedOnly.parentKey, `codex:${PARENT}`, 'nested-only source must build the parent link');
  const conflict = session(store, CONFLICT);
  assert.equal(conflict.parentKey, `codex:${PARENT}`, 'documented priority: top-level beats nested');
  await watcher.close(); store.close();
});

test('未知子类型计 unknown，不吞成 ignored；已知忽略类型维持 ignored', async () => {
  const today = datedDir(path.join(home, '.codex', 'sessions'));
  // Isolated counters: the shared fixtures carry their own intentional noise.
  const fsp = await import('node:fs/promises');
  for (const name of await fsp.readdir(today)) await fsp.rm(path.join(today, name));
  await writeFile(path.join(today, `rollout-2026-11-07T09-02-00-${UNK}.jsonl`),
    [
      JSON.stringify({ timestamp: FIX(45), type: 'session_meta', payload: { id: UNK, cwd: 'C:/private/demo' } }),
      // understood-but-unused response_item subtypes → ignored
      JSON.stringify({ timestamp: FIX(45), type: 'response_item', payload: { type: 'agent_message', id: 'a1' } }),
      JSON.stringify({ timestamp: FIX(45), type: 'response_item', payload: { type: 'additional_tools', id: 'a2', tools: [] } }),
      JSON.stringify({ timestamp: FIX(45), type: 'response_item', payload: { type: 'compaction', id: 'a3' } }),
      // unknown subtypes at every level → unknown
      JSON.stringify({ timestamp: FIX(45), type: 'response_item', payload: { type: 'brand_new_future_type', id: 'u1' } }),
      JSON.stringify({ timestamp: FIX(45), type: 'event_msg', payload: { type: 'future_event_kind', id: 'u2' } }),
      JSON.stringify({ timestamp: FIX(45), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'x', turn_id: 't', item: { type: 'FutureItemKind', id: 'u3' } } }),
      JSON.stringify({ timestamp: FIX(45), type: 'brand_new_top_level', payload: {} }),
      // understood-but-unused item types → ignored
      JSON.stringify({ timestamp: FIX(45), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'x', turn_id: 't', item: { type: 'Reasoning', id: 'r1' } } }),
      JSON.stringify({ timestamp: FIX(45), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'x', turn_id: 't', item: { type: 'FileChange', id: 'f1', changes: [] } } }),
    ].join('\n') + '\n');
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const h = health(watcher);
  assert.equal(h.unknownRecords, 4, 'top-level + response_item + event_msg + item_completed unknowns');
  // ignored on this file: agent_message + additional_tools + compaction + Reasoning + FileChange = 5
  assert.ok(h.ignoredRecords >= 5, `known-unused types still ignored (got ${h.ignoredRecords})`);
  await watcher.close(); store.close();
});

test('混合通道：无可靠 id 时完成项独立保留（未关联口径）', async () => {
  const today = datedDir(path.join(home, '.codex', 'sessions'));
  const mk = (sid, arr) => writeFile(path.join(today, `rollout-2026-11-07T09-03-00-${sid}.jsonl`), arr.join('\n') + '\n');
  // item.id 与 call_id 不同：无可靠关联 → 完成项独立计数（不猜测合并）
  await mk(SAMECALL, [
    JSON.stringify({ timestamp: FIX(46), type: 'session_meta', payload: { id: SAMECALL, cwd: 'C:/private/demo' } }),
    JSON.stringify({ timestamp: FIX(46), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', model_context_window: 128000 } }),
    JSON.stringify({ timestamp: FIX(46), type: 'response_item', payload: { type: 'function_call', id: 'f1', call_id: 'k1', name: 'shell', input: '{"command":["bash","-lc","npm test"]}' } }),
    JSON.stringify({ timestamp: FIX(46), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'x', turn_id: 't1', item: { type: 'CommandExecution', id: 'i1', command: ['bash', '-lc', 'npm test'], exit_code: 0, status: 'completed' }, started_at_ms: 1, completed_at_ms: 2 } }),
    JSON.stringify({ timestamp: FIX(46), type: 'response_item', payload: { type: 'function_call_output', id: 'o1', call_id: 'k1', output: '{"exit_code":0}' } }),
    JSON.stringify({ timestamp: FIX(46), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }),
  ]);
  await mk(INDEP, [
    JSON.stringify({ timestamp: FIX(47), type: 'session_meta', payload: { id: INDEP, cwd: 'C:/private/demo' } }),
    JSON.stringify({ timestamp: FIX(47), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', model_context_window: 128000 } }),
    JSON.stringify({ timestamp: FIX(47), type: 'response_item', payload: { type: 'function_call', id: 'fA', call_id: 'kA', name: 'shell', input: '{"command":["bash","-lc","cargo build"]}' } }),
    JSON.stringify({ timestamp: FIX(47), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'x', turn_id: 't1', item: { type: 'CommandExecution', id: 'iB', command: ['npm', 'run', 'lint'], exit_code: 1, status: 'completed' }, started_at_ms: 3, completed_at_ms: 4 } }),
    JSON.stringify({ timestamp: FIX(47), type: 'response_item', payload: { type: 'function_call_output', id: 'oA', call_id: 'kA', output: '{"exit_code":0}' } }),
    JSON.stringify({ timestamp: FIX(47), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }),
  ]);
  // 可靠 id 关联：item.id === call_id → 只计一次，输出被抑制
  await mk(REVERSED, [
    JSON.stringify({ timestamp: FIX(48), type: 'session_meta', payload: { id: REVERSED, cwd: 'C:/private/demo' } }),
    JSON.stringify({ timestamp: FIX(48), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', model_context_window: 128000 } }),
    JSON.stringify({ timestamp: FIX(48), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'x', turn_id: 't1', item: { type: 'CommandExecution', id: 'kC', command: ['bash', '-lc', 'make all'], exit_code: 0, status: 'completed' }, started_at_ms: 5, completed_at_ms: 6 } }),
    JSON.stringify({ timestamp: FIX(48), type: 'response_item', payload: { type: 'function_call', id: 'fC', call_id: 'kC', name: 'shell', input: '{"command":["bash","-lc","make all"]}' } }),
    JSON.stringify({ timestamp: FIX(48), type: 'response_item', payload: { type: 'function_call_output', id: 'oC', call_id: 'kC', output: '{"exit_code":0}' } }),
    JSON.stringify({ timestamp: FIX(48), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }),
  ]);
  const { store, watcher } = await startWatcher(await makeConfig());
  await discoverAll(watcher);
  const a = session(store, SAMECALL);
  assert.equal(a.toolCalls, 2, 'paired call k1 + unlinked completion i1 (no guessed merge)');
  assert.equal(a.toolErrors, 0);
  const b = session(store, INDEP);
  assert.equal(b.toolCalls, 2, 'independent completion B kept alongside parallel call A');
  assert.equal(b.toolErrors, 1, 'completion evidence exit_code=1 preserved');
  const c = session(store, REVERSED);
  assert.equal(c.toolCalls, 1, 'reliable id (item.id === call_id): counted once in reversed order');
  await watcher.close(); store.close();
});
