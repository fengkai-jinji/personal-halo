// ZCode adapter tests against a synthetic db.sqlite with the real column
// shapes (verified read-only against the local store in A phase). Covers:
// parent linkage, live tool pairing, part-type activity, single-scope token
// accounting with retry dedup, turn boundary pulses, todo plan snapshot,
// tasks-index metadata merge, epoch-0 skipping, WAL updates and the
// "database activity ≠ running" rule.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const zcode = (await import('../src/adapters/zcode.js')).default;
import { Store } from '../src/store.js';
import { Watcher } from '../src/watch.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SID = 'sess_cc2140ed-0000-4000-8000-0000000000aa';
const CHILD = 'sess_subagent_agent_0000-0000-4000-8000-0000000000bb';
const NOW = () => Date.now();

let home;
let dbFile;
let indexFile;

function createDb() {
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, task_type TEXT, title TEXT,
      directory TEXT, time_created INTEGER, time_updated INTEGER, last_outcome TEXT);
    CREATE TABLE tool_usage (id TEXT PRIMARY KEY, session_id TEXT, tool_call_id TEXT, tool_name TEXT,
      status TEXT, started_at INTEGER, completed_at INTEGER, exit_code INTEGER);
    CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT, logical_request_id TEXT,
      attempt_index INTEGER, status TEXT, model_id TEXT, started_at INTEGER, completed_at INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_read_input_tokens INTEGER, computed_total_tokens INTEGER);
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER);
    CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER, time_updated INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);`);
  return db;
}

function createIndex() {
  const db = new DatabaseSync(indexFile);
  db.exec(`CREATE TABLE tasks (task_id TEXT, title TEXT, task_status TEXT, mode TEXT, model TEXT,
      provider TEXT, workspace_path TEXT, created_at INTEGER, updated_at INTEGER,
      archived INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, forked_from_task_id TEXT);`);
  return db;
}

async function makeConfig() {
  return {
    privacy: 'titles', detail: 'basic', visibleIdleMin: 600, maxSessions: 12,
    staleSec: 90, toolStaleSec: 900,
    adapters: { zcode: { enabled: true, roots: [dbFile, indexFile] } },
  };
}

async function startWatcher(config) {
  const store = new Store(config);
  const watcher = new Watcher([zcode], store, config);
  await watcher.start(false);
  return { store, watcher };
}

const session = (store, sid = SID) => store.entries.get(`zcode:${sid}`)?.session;
const health = watcher => watcher.health()[0];
const readAll = async watcher => {
  await Promise.all([...watcher.files.values()].map(entry => watcher.read(entry)));
  await sleep(100);
};

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'personal-halo-zcode-'));
  await mkdir(path.join(home, '.zcode', 'cli', 'db'), { recursive: true });
  await mkdir(path.join(home, '.zcode', 'v2'), { recursive: true });
  dbFile = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  indexFile = path.join(home, '.zcode', 'v2', 'tasks-index.sqlite');
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

test('会话/父子/实时工具/流式活动/turn 脉冲/计划快照', async () => {
  const db = createDb();
  const t = NOW() - 5000;
  db.prepare(`INSERT INTO session (id, parent_id, task_type, title, directory, time_created, time_updated)
    VALUES (?, NULL, 'interactive', '主会话标题', 'C:/private/proj/sub', ?, ?)`).run(SID, t - 60000, t);
  db.prepare(`INSERT INTO session (id, parent_id, task_type, title, directory, time_created, time_updated)
    VALUES (?, ?, 'subagent_child', '子代理', 'C:/private/proj/sub', ?, ?)`).run(CHILD, SID, t - 50000, t - 1000);
  // live running tool → tool state; terminal rows without prior running are history
  db.prepare(`INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, status, started_at)
    VALUES ('t1', ?, 'call_1', 'Bash', 'running', ?)`).run(SID, t);
  db.prepare(`INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, status, started_at, completed_at)
    VALUES ('t0', ?, 'call_0', 'Read', 'completed', ?, ?)`).run(SID, t - 30000, t - 29000);
  // streaming activity via part type projection
  db.prepare(`INSERT INTO part (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`)
    .run('p1', SID, t - 1000, JSON.stringify({ type: 'text', text: 'PRIVATE_SYNTHETIC_BODY' }));
  db.prepare(`INSERT INTO part (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`)
    .run('p2', SID, t - 900, JSON.stringify({ type: 'reasoning', text: 'PRIVATE_SYNTHETIC_REASONING' }));
  // terminal turn row → start+end pulse pair
  db.prepare(`INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at)
    VALUES (?, 'turn_1', 'completed', ?, ?)`).run(SID, t - 20000, t - 10000);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);

  const s = session(store);
  assert.ok(s, 'session created from db.sqlite');
  assert.equal(s.title, '主会话标题');
  assert.equal(s.project, 'sub');
  assert.equal(s.toolCalls, 1, 'running tool counted; historical terminal not replayed');
  assert.equal(s.currentTool.name, 'Bash');
  assert.equal(s.state, 'tool');
  const child = session(store, CHILD);
  assert.equal(child.parentKey, `zcode:${SID}`, 'subagent child linked via parent_id');
  assert.equal(s.turn, 1, 'terminal turn row pulses start+end once');
  assert.equal(s.tasks, null, 'no todo rows → no plan');
  assert.ok(!JSON.stringify(store.snapshot()).includes('PRIVATE_SYNTHETIC'), 'part content never leaves the DB');
  await watcher.close(); store.close();
});

test('token 单一口径：重试取最高 attempt 终态、completed 才计入、不与 turn_usage 相加', async () => {
  const db = createDb();
  const t = NOW() - 5000;
  db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`).run(SID, t, t);
  const ins = db.prepare(`INSERT INTO model_usage (id, session_id, logical_request_id, attempt_index, status,
      model_id, started_at, input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, computed_total_tokens)
    VALUES (?, ?, ?, ?, ?, 'synthetic-model', ?, ?, ?, ?, ?, ?)`);
  ins.run('m1', SID, 'req_1', 0, 'error', t, 100, 10, 0, 0, 110);       // failed first attempt
  ins.run('m2', SID, 'req_1', 1, 'completed', t, 200, 30, 5, 40, 235);  // retried, completed
  ins.run('m3', SID, 'req_2', 0, 'cancelled', t, 500, 60, 0, 0, 560);   // cancelled: excluded
  ins.run('m4', SID, 'req_3', 0, 'completed', t, 1000, 100, 10, 100, 1110);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  const s = session(store);
  assert.equal(s.model, 'synthetic-model');
  assert.deepEqual(
    { input: s.tokens.input, output: s.tokens.output, reasoning: s.tokens.reasoning, cacheRead: s.tokens.cacheRead, total: s.tokens.total },
    { input: 1200, output: 130, reasoning: 15, cacheRead: 140, total: 1345 },
    'retry keeps the terminal completed attempt; cancelled excluded');
  assert.equal(s.context, null, 'no context window is fabricated');
  await watcher.close(); store.close();
});

test('WAL 增量：工具完成与 todo 更新被增量发现', async () => {
  const db = createDb();
  const t = NOW() - 5000;
  db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`).run(SID, t, t);
  db.prepare(`INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, status, started_at)
    VALUES ('t1', ?, 'call_1', 'Bash', 'running', ?)`).run(SID, t);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  assert.equal(session(store).state, 'tool');

  const db2 = new DatabaseSync(dbFile);
  db2.prepare(`UPDATE tool_usage SET status='completed', completed_at=?, exit_code=0 WHERE id='t1'`).run(NOW());
  db2.prepare(`INSERT INTO todo (session_id, content, status, priority, position, time_updated)
    VALUES (?, '步骤甲', 'in_progress', 'high', 0, ?)`).run(SID, NOW());
  db2.prepare(`UPDATE session SET time_updated=? WHERE id=?`).run(NOW(), SID);
  db2.close();
  await readAll(watcher);
  const s = session(store);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.currentTool, null, 'running tool completed via tool_end');
  assert.deepEqual(s.tasks.items.map(i => [i.text, i.status]), [['步骤甲', 'active']]);
  await watcher.close(); store.close();
});

test('tasks-index 元数据合并：终态仅元数据、epoch0 跳过、archived 排除', async () => {
  const db = createIndex();
  const t = NOW() - 5000;
  db.prepare(`INSERT INTO tasks (task_id, title, task_status, mode, model, workspace_path, created_at, updated_at)
    VALUES (?, '索引标题', 'completed', 'build', 'synthetic-model', 'C:/private/idx', ?, ?)`).run(SID, t - 60000, t);
  db.prepare(`INSERT INTO tasks (task_id, title, task_status, workspace_path, created_at, updated_at)
    VALUES ('sess_legacy', null, null, null, 0, 0)`).run();
  db.prepare(`INSERT INTO tasks (task_id, title, task_status, archived, updated_at)
    VALUES ('sess_archived', '归档', 'completed', 1, ?)`).run(t);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  const s = session(store);
  assert.equal(s.title, '索引标题');
  assert.equal(s.project, 'idx');
  assert.equal(s.state, 'idle', 'terminal task_status never fakes a running state');
  assert.equal(store.entries.get('zcode:sess_legacy'), undefined, 'epoch-0 migrated row skipped');
  assert.equal(store.entries.get('zcode:sess_archived'), undefined, 'archived row excluded');
  await watcher.close(); store.close();
});

test('数据库活动时间不能单独表示运行中：安静会话保持 idle', async () => {
  const db = createDb();
  const t = NOW() - 5 * 60 * 1000; // recent activity, but nothing open
  db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`).run(SID, t, t);
  db.prepare(`INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, status, started_at, completed_at)
    VALUES ('t0', ?, 'call_0', 'Read', 'completed', ?, ?)`).run(SID, t, t + 100);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  const s = session(store);
  assert.ok(s);
  assert.equal(s.state, 'idle', 'recent db activity alone must not fake running');
  await watcher.close(); store.close();
});

test('schema 不支持：缺核心表时明确诊断', async () => {
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE other (x TEXT);');
  db.close();
  const { watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  assert.match(health(watcher).lastError ?? '', /SchemaUnsupported/);
  await watcher.close();
});
