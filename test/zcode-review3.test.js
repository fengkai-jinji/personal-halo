// ZCode review round 3 regressions (audit/Codex-B阶段二次复审.md #2):
// startup must not replay historical part/turn activity as current state;
// part/turn signals belong to metadata-discovered sessions only; genuinely
// new incremental activity and explicitly still-running tools keep working.
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
const SID = 'sess_recent-0000-4000-8000-0000000000aa';
const ANCIENT = 'sess_ancient-0000-4000-8000-0000000000bb';
const NOW = () => Date.now();
const DAY = 86400000;

let home;
let dbFile;

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

async function makeConfig() {
  return {
    privacy: 'titles', detail: 'basic', visibleIdleMin: 600, maxSessions: 12,
    staleSec: 90, toolStaleSec: 900,
    adapters: { zcode: { enabled: true, roots: [dbFile] } },
  };
}

async function startWatcher(config) {
  const store = new Store(config);
  const watcher = new Watcher([zcode], store, config);
  await watcher.start(false);
  return { store, watcher };
}

const session = (store, sid = SID) => store.entries.get(`zcode:${sid}`)?.session;
const readAll = async watcher => {
  await Promise.all([...watcher.files.values()].map(entry => watcher.read(entry)));
  await sleep(100);
};

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'personal-halo-zcode-r3-'));
  await mkdir(path.join(home, '.zcode', 'cli', 'db'), { recursive: true });
  dbFile = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

test('仅旧 reasoning part 的被排除会话不复活为等待中', async () => {
  const db = createDb();
  const now = NOW();
  for (let i = 0; i < 32; i++) {
    db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`)
      .run(`sess_recent_${i}`, now - i, now - i);
  }
  db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`)
    .run(ANCIENT, now - 7 * DAY, now - 7 * DAY);
  db.prepare(`INSERT INTO part (id, session_id, time_created, data) VALUES ('p1', ?, ?, ?)`)
    .run(ANCIENT, now - 7 * DAY, JSON.stringify({ type: 'reasoning', text: 'PRIVATE_SYNTHETIC_OLD' }));
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  await watcher.close(); store.close();
  const db2 = new DatabaseSync(dbFile);
  db2.prepare(`UPDATE session SET time_updated=? WHERE id=?`).run(now, ANCIENT.slice(0, -1) + 'x'); // unrelated change
  db2.close();
  const { store: s2, watcher: w2 } = await startWatcher(await makeConfig());
  await readAll(w2);
  const entry = s2.entries.get(`zcode:${ANCIENT}`);
  assert.equal(entry, undefined, 'ancient session never revived by old parts');
  await w2.close(); s2.close();
});

test('启动初始化不把历史 part/turn 重放为在线状态；增量新事件正常', async () => {
  const db = createDb();
  const now = NOW();
  // Session is recently active (discoverable), but its logged part/turn
  // rows are two days old: startup must not replay them as current activity.
  db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`).run(SID, now - 2 * DAY, now);
  db.prepare(`INSERT INTO part (id, session_id, time_created, data) VALUES ('p-old', ?, ?, ?)`)
    .run(SID, now - 2 * DAY, JSON.stringify({ type: 'text', text: 'PRIVATE_SYNTHETIC_OLD_TEXT' }));
  db.prepare(`INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at)
    VALUES (?, 'turn-old', 'completed', ?, ?)`).run(SID, now - 2 * DAY, now - 2 * DAY + 1000);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  const s = session(store, SID);
  assert.ok(s, 'session discovered from metadata');
  assert.equal(s.state, 'idle', 'startup must not replay old parts as current activity');
  // Terminal turn pairs are silently rebuilt into the counter (pulses are
  // suppressed by store.silent during startup); they cannot fake an online
  // state because they always end in idle/error. Transient parts are skipped.
  assert.equal(s.turn, 1, 'terminal turn pairs rebuild the counter without pulses');

  // Genuinely new incremental part → real activity.
  const db2 = new DatabaseSync(dbFile);
  db2.prepare(`INSERT INTO part (id, session_id, time_created, data) VALUES ('p-new', ?, ?, ?)`)
    .run(SID, NOW(), JSON.stringify({ type: 'reasoning', text: 'PRIVATE_SYNTHETIC_NEW' }));
  db2.prepare(`UPDATE session SET time_updated=? WHERE id=?`).run(NOW(), SID);
  db2.close();
  await readAll(watcher);
  const s2 = session(store, SID);
  assert.equal(s2.state, 'thinking', 'new incremental part is real activity');
  await watcher.close(); store.close();
});

test('旧终态 turn 不复活会话；明确仍运行的长工具保留证据', async () => {
  const db = createDb();
  const now = NOW();
  for (let i = 0; i < 32; i++) {
    db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`)
      .run(`sess_r_${i}`, now - i, now - i);
  }
  db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`)
    .run(ANCIENT, now - 7 * DAY, now - 7 * DAY);
  db.prepare(`INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at)
    VALUES (?, 'turn-ancient', 'completed', ?, ?)`).run(ANCIENT, now - 7 * DAY, now - 7 * DAY + 500);
  // An explicitly still-running long tool on a DISCOVERED session stays live.
  db.prepare(`INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, status, started_at)
    VALUES ('t_long', 'sess_r_0', 'call_long', 'Bash', 'running', ?)`).run(now - 20 * 60 * 1000);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  assert.equal(store.entries.get(`zcode:${ANCIENT}`), undefined, 'old terminal turn does not revive the excluded session');
  const longTool = [...store.entries.values()].map(e => e.session).find(x => x.toolCalls === 1 && x.currentTool?.name === 'Bash');
  assert.ok(longTool, 'explicitly running long tool keeps live evidence (not cut by a time threshold)');
  await watcher.close(); store.close();
});
