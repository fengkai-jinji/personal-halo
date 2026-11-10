// ZCode review round 2 regressions (audit/Codex-B阶段审查与修订任务.md #5/#6/#7):
// completion backfills never fabricate streaming rate and always carry source
// activity time, ancient sessions are not revived by usage rows, the latest
// model wins stably, and tools that finish after 15 minutes still close.
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
const NOW = () => Date.now();

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
  home = await mkdtemp(path.join(os.tmpdir(), 'personal-halo-zcode-r2-'));
  await mkdir(path.join(home, '.zcode', 'cli', 'db'), { recursive: true });
  dbFile = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

test('完成回填不产生实时速率；token 用源活动时间', async () => {
  const db = createDb();
  const t = NOW() - 5000;
  db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`).run(SID, t, t);
  const ins = db.prepare(`INSERT INTO model_usage (id, session_id, logical_request_id, attempt_index, status,
      model_id, started_at, completed_at, input_tokens, output_tokens, computed_total_tokens)
    VALUES (?, ?, ?, 0, 'completed', 'm', ?, ?, 100, 20, 120)`);
  ins.run('m1', SID, 'r1', t - 4000, t - 3000);
  ins.run('m2', SID, 'r2', t - 2000, t - 1000);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  const pulses = [];
  store.on('pulse', p => pulses.push(p));
  await readAll(watcher);
  const s = session(store);
  assert.equal(s.tokens.output, 40, 'totals accumulate from backfills');
  assert.equal(s.tps, null, 'completion backfills must not fabricate streaming rate');
  assert.ok(!pulses.some(p => p.kind === 'tokens' && p.tokensDelta !== undefined), 'no tokensDelta pulses from backfills');
  await watcher.close(); store.close();
});

test('7 天前且被 metadata 排除的会话不因用量查询复活', async () => {
  const db = createDb();
  const t = NOW() - 5000;
  db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`).run(SID, t, t);
  // 33 sessions: SID plus 32 recent dummies; the ancient one falls outside LIMIT 32.
  for (let i = 0; i < 32; i++) {
    db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`)
      .run(`sess_dummy_${i}`, t - i, t - i);
  }
  db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES ('sess_ancient', ?, ?)`)
    .run(t - 7 * 86400000, t - 7 * 86400000);
  db.prepare(`INSERT INTO model_usage (id, session_id, logical_request_id, attempt_index, status, model_id,
      started_at, completed_at, input_tokens, output_tokens, computed_total_tokens)
    VALUES ('m9', 'sess_ancient', 'r9', 0, 'completed', 'm', ?, ?, 1, 1, 2)`).run(t - 6 * 86400000, t - 6 * 86400000);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  assert.equal(store.entries.get('zcode:sess_ancient'), undefined, 'ancient session never revived');
  assert.ok(store.entries.get(`zcode:${SID}`), 'recent session present');
  await watcher.close(); store.close();
});

test('模型取最新一条且稳定：旧模型不得覆盖新模型，空轮询不重复发送', async () => {
  const db = createDb();
  const t = NOW() - 5000;
  db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`).run(SID, t, t);
  const ins = db.prepare(`INSERT INTO model_usage (id, session_id, logical_request_id, attempt_index, status,
      model_id, started_at, completed_at) VALUES (?, ?, ?, 0, 'completed', ?, ?, ?)`);
  ins.run('m_old', SID, 'r_old', 'old-model', t - 4000, t - 3900);
  ins.run('m_new', SID, 'r_new', 'new-model', t - 1000, t - 900);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  assert.equal(session(store).model, 'new-model', 'latest model wins regardless of row order');
  await readAll(watcher);
  await readAll(watcher);
  assert.equal(session(store).model, 'new-model', 'repeated empty polls keep the latest model');
  await watcher.close(); store.close();
});

test('超过 15 分钟才完成的工具仍能闭合；并行长短工具互不影响', async () => {
  const db = createDb();
  const t = NOW() - 5000;
  db.prepare(`INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`).run(SID, t, t);
  const nowMs = NOW();
  db.prepare(`INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, status, started_at)
    VALUES ('t_long', ?, 'call_long', 'Bash', 'running', ?)`).run(SID, nowMs - 16 * 60 * 1000);
  db.prepare(`INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, status, started_at)
    VALUES ('t_short', ?, 'call_short', 'Read', 'running', ?)`).run(SID, nowMs - 1000);
  db.close();
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  assert.equal(session(store).toolCalls, 2, 'both running tools started');

  const db2 = new DatabaseSync(dbFile);
  db2.prepare(`UPDATE tool_usage SET status='completed', completed_at=? WHERE id='t_long'`).run(nowMs - 100);
  db2.close();
  await readAll(watcher);
  const s = session(store);
  assert.equal(s.toolErrors, 0);
  assert.ok(s.recentTools.find(x => x.name === 'Bash')?.ok === true, 'long tool closed beyond the 15min window');
  await watcher.close(); store.close();
});
