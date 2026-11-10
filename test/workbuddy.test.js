// WorkBuddy adapter tests against a synthetic workbuddy.db and tasks
// directory with the real column/file shapes verified in the A-phase audit.
// Covers: sessions metadata merge, deleted exclusion, context occupancy pair,
// tasks directory ownership + per-session aggregation, residual in_progress
// snapshot semantics, and the no-fake-running rule.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const workbuddy = (await import('../src/adapters/workbuddy.js')).default;
import { Store } from '../src/store.js';
import { Watcher } from '../src/watch.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SID = '248844ee-1e98-48eb-9dec-c9cba1f3c9e8';
const SID2 = '914b0360-0000-48eb-9dec-c9cba1f3c9e9';

let home;
let dbFile;
let tasksDir;

async function makeConfig() {
  return {
    privacy: 'titles', detail: 'basic', visibleIdleMin: 600, maxSessions: 12,
    staleSec: 90, toolStaleSec: 900,
    adapters: { workbuddy: { enabled: true, roots: [dbFile, tasksDir] } },
  };
}

async function startWatcher(config) {
  const store = new Store(config);
  const watcher = new Watcher([workbuddy], store, config);
  await watcher.start(false);
  return { store, watcher };
}

const session = (store, sid = SID) => store.entries.get(`workbuddy:${sid}`)?.session;
const readAll = async watcher => {
  await Promise.all([...watcher.files.values()].map(entry => watcher.read(entry)));
  await sleep(100);
};

test('明确 working 才进入执行态；仅状态变化也能退出，旧 working 不复活', async () => {
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT,
      status TEXT, model TEXT, context_window INTEGER, created_at INTEGER, updated_at INTEGER,
      last_activity_at INTEGER, deleted_at INTEGER);
    CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, updated_at INTEGER);`);
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO sessions (id,title,status,created_at,updated_at,last_activity_at)
    VALUES (?, 'fixture', ?, ?, ?, ?)`);
  insert.run(SID, 'working', now-60000, now, now);
  insert.run(SID2, 'working', now-600000, now-600000, now-600000);
  const {store,watcher} = await startWatcher(await makeConfig());
  try {
    await readAll(watcher);
    assert.equal(session(store).state, 'thinking', 'fresh explicit working is execution evidence');
    assert.equal(session(store,SID2).state, 'idle', 'old working must not revive');
    db.prepare("UPDATE sessions SET status='completed' WHERE id=?").run(SID);
    await readAll(watcher);
    assert.equal(session(store).state, 'idle', 'status-only completion cannot be skipped by metadata stamp');
  } finally { await watcher.close(); store.close(); db.close(); }
});

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'personal-halo-wb-'));
  dbFile = path.join(home, '.workbuddy', 'workbuddy.db');
  tasksDir = path.join(home, '.workbuddy', 'tasks');
  await mkdir(path.dirname(dbFile), { recursive: true });
  await mkdir(tasksDir, { recursive: true });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

test('sessions 元数据、deleted 排除、上下文占用对、不伪造运行状态', async () => {
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT,
      status TEXT, model TEXT, context_window INTEGER, created_at INTEGER, updated_at INTEGER,
      last_activity_at INTEGER, deleted_at INTEGER);
    CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, updated_at INTEGER);`);
  const t = Date.now() - 5000;
  db.prepare(`INSERT INTO sessions (id, cwd, title, custom_title, status, model, context_window,
      created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, 'completed', 'deepseek-synthetic', 300000, ?, ?, ?)`)
    .run(SID, 'C:/private/wb/proj', null, '自定义标题', t - 60000, t, t);
  db.prepare(`INSERT INTO sessions (id, cwd, title, status, created_at, updated_at, deleted_at)
    VALUES ('deleted-row', 'C:/x', '已删除', 'completed', ?, ?, ?)`).run(t, t, t);
  db.prepare(`INSERT INTO session_usage (session_id, used, size, updated_at) VALUES (?, ?, 300000, ?)`)
    .run(SID, 150000, t);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  const s = session(store);
  assert.ok(s);
  assert.equal(s.title, '自定义标题');
  assert.equal(s.project, 'proj');
  assert.equal(s.model, 'deepseek-synthetic');
  // Context pair passes through as occupancy; the display gate stays in the UI.
  assert.equal(s.context.used, 150000);
  assert.equal(s.context.window, 300000);
  assert.equal(s.state, 'idle', 'no running state is fabricated from db recency');
  assert.equal(store.entries.get('workbuddy:deleted-row'), undefined, 'deleted rows excluded');
  await watcher.close(); store.close();
});

test('tasks 目录：id 归属会话、跨文件聚合、结束残留 in_progress 按快照显示', async () => {
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT,
      status TEXT, model TEXT, context_window INTEGER, created_at INTEGER, updated_at INTEGER,
      last_activity_at INTEGER, deleted_at INTEGER);
    CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, updated_at INTEGER);`);
  const t = Date.now() - 5000;
  db.prepare(`INSERT INTO sessions (id, cwd, title, status, created_at, updated_at, last_activity_at)
    VALUES (?, 'C:/private/wb/proj', '库标题', 'completed', ?, ?, ?)`).run(SID, t - 60000, t, t);
  db.close();
  const dir = path.join(tasksDir, SID);
  await mkdir(dir, { recursive: true });
  const steps = [
    { subject: '步骤甲', description: 'PRIVATE_SYNTHETIC_DESC', activeForm: '正在做甲', status: 'completed', id: 1, createdAt: t - 5000, updatedAt: t - 4000 },
    { subject: '步骤乙', description: 'PRIVATE_SYNTHETIC_DESC', activeForm: '正在做乙', status: 'in_progress', id: 2, createdAt: t - 3000, updatedAt: t - 2000 },
    { subject: '步骤丙', description: 'PRIVATE_SYNTHETIC_DESC', activeForm: null, status: 'pending', id: 3, createdAt: t - 1000, updatedAt: t - 900 },
  ];
  for (const step of steps) await writeFile(path.join(dir, `${step.id}.json`), JSON.stringify(step));

  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  const s = session(store);
  assert.ok(s, 'session created from db; tasks enrich it');
  assert.deepEqual(s.tasks.items.map(i => [i.text, i.status]),
    [['步骤甲', 'done'], ['正在做乙', 'active'], ['步骤丙', 'pending']],
    'per-session aggregation across files; in_progress uses activeForm; residuals kept as snapshot');
  assert.equal(s.tasks.done, 1);
  assert.ok(!JSON.stringify(store.snapshot()).includes('PRIVATE_SYNTHETIC'), 'task descriptions never enter signals');

  // A task file update moves the step forward without touching the db.
  await writeFile(path.join(dir, '2.json'), JSON.stringify({ ...steps[1], status: 'completed', activeForm: null, updatedAt: t - 500 }));
  await readAll(watcher);
  assert.equal(session(store).tasks.done, 2, 'snapshot update discovered via file mtime');
  await watcher.close(); store.close();
});

test('tasks 文件只 enrich 已有会话（auxiliary 语义）', async () => {
  const dir = path.join(tasksDir, SID2);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '1.json'),
    JSON.stringify({ subject: '孤儿步骤', status: 'pending', id: 1, createdAt: Date.now(), updatedAt: Date.now() }));
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  assert.equal(store.entries.get(`workbuddy:${SID2}`), undefined,
    'task files without a discovered session must not fabricate one');
  await watcher.close(); store.close();
});
