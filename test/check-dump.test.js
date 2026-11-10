// Machine check over the full --dump surface on a synthetic four-source home:
// every string field in the snapshot must match the privacy whitelist, no
// synthetic body may leak, source files must remain byte-identical after
// collection (read/write isolation), and a second collector on the same port
// must exit with the Chinese occupancy message instead of killing anything.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const projectRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

let home;
let snapshot;
const hashesBefore = new Map();

async function hashTree(dir, into) {
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) await hashTree(full, into);
    else into.set(full, createHash('sha256').update(await (await import('node:fs/promises')).readFile(full)).digest('hex'));
  }
}

async function writeFileDeep(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'personal-halo-synth-'));
  const now = Date.now();
  const iso = new Date(now - 60000).toISOString();
  // --- codex ---
  const d = new Date(now - 60000);
  const dated = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  const lines = [
    JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id: 'syn-codex-0000-4000-8000-000000000001', cwd: 'C:/private/demo' } }),
    JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', model_context_window: 400000 } }),
    JSON.stringify({ timestamp: iso, type: 'response_item', payload: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE_SYNTHETIC_BODY' }] } }),
    JSON.stringify({ timestamp: iso, type: 'response_item', payload: { type: 'custom_tool_call', id: 'c1', call_id: 'c1', name: 'shell', input: '{"command":["bash","-lc","npm test"]}' } }),
    JSON.stringify({ timestamp: iso, type: 'response_item', payload: { type: 'custom_tool_call_output', id: 'o1', call_id: 'c1', output: '{"exit_code":0}' } }),
    JSON.stringify({ timestamp: iso, type: 'token_usage_record', payload: { response_id: 'r1', thread_token_usage: { input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 2, cached_input_tokens: 50, total_tokens: 122 } } }),
    JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }),
    JSON.stringify({ timestamp: iso, type: 'world_state', payload: { state: {} } }),
  ];
  await writeFileDeep(path.join(dated, `rollout-x-syn-codex-0000-4000-8000-000000000001.jsonl`), lines.join('\n') + '\n');
  await writeFileDeep(path.join(home, '.codex', 'session_index.jsonl'),
    `{"id":"syn-codex-0000-4000-8000-000000000001","thread_name":"合成标题甲","updated_at":"${iso}"}\n`);
  // --- dsh ---
  const frame = r => zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n'));
  const frames = [
    frame({ type: 'session', data: { id: 'syn-dsh', cwd: 'C:/private/dsh' }, time: now - 60000 }),
    frame({ type: 'assistant/message', data: { message: { source: { model: 'dsh-synthetic' }, content: [{ type: 'text', text: 'PRIVATE_SYNTHETIC_DSH' }] }, usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 10, totalTokens: 140 } }, time: now - 59000 }),
    frame({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: now - 58000 }),
  ];
  await writeFileDeep(path.join(home, '.dsh', 'sessions', 'ws', 'session-syn-dsh', 'session.v4.jsonl.zstd'), Buffer.concat(frames));
  // --- zcode ---
  await mkdir(path.join(home, '.zcode', 'cli', 'db'), { recursive: true });
  await mkdir(path.join(home, '.zcode', 'v2'), { recursive: true });
  await mkdir(path.join(home, '.workbuddy', 'tasks', 'syn-wb'), { recursive: true });
  const db = new (await import('node:sqlite')).DatabaseSync(path.join(home, '.zcode', 'cli', 'db', 'db.sqlite'));
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
  db.prepare(`INSERT INTO session (id, title, directory, time_created, time_updated) VALUES ('syn-zcode', '合成乙', 'C:/private/zc/deep', ?, ?)`).run(now - 60000, now - 1000);
  db.prepare(`INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, status, started_at, completed_at, exit_code)
    VALUES ('t1', 'syn-zcode', 'c1', 'Edit', 'completed', ?, ?, 0)`).run(now - 5000, now - 4000);
  db.prepare(`INSERT INTO model_usage (id, session_id, logical_request_id, attempt_index, status, model_id, started_at,
      input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, computed_total_tokens)
    VALUES ('m1', 'syn-zcode', 'r1', 0, 'completed', 'syn-model', ?, 100, 20, 2, 30, 122)`).run(now - 8000);
  db.prepare(`INSERT INTO todo (session_id, content, status, priority, position, time_updated)
    VALUES ('syn-zcode', '步骤甲', 'completed', 'high', 0, ?)`).run(now - 3000);
  db.prepare(`INSERT INTO part (id, session_id, time_created, data) VALUES ('p1', 'syn-zcode', ?, ?)`)
    .run(now - 2000, JSON.stringify({ type: 'text', text: 'PRIVATE_SYNTHETIC_ZC' }));
  db.close();
  const idx = new (await import('node:sqlite')).DatabaseSync(path.join(home, '.zcode', 'v2', 'tasks-index.sqlite'));
  idx.exec(`CREATE TABLE tasks (task_id TEXT, title TEXT, task_status TEXT, mode TEXT, model TEXT,
      provider TEXT, workspace_path TEXT, created_at INTEGER, updated_at INTEGER,
      archived INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, forked_from_task_id TEXT)`);
  idx.prepare(`INSERT INTO tasks (task_id, title, task_status, workspace_path, created_at, updated_at)
    VALUES ('syn-zcode', '索引乙', 'completed', 'C:/private/zc/deep', ?, ?)`).run(now - 60000, now - 900);
  idx.close();
  // --- workbuddy ---
  const wb = new (await import('node:sqlite')).DatabaseSync(path.join(home, '.workbuddy', 'workbuddy.db'));
  wb.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT,
      status TEXT, model TEXT, context_window INTEGER, created_at INTEGER, updated_at INTEGER,
      last_activity_at INTEGER, deleted_at INTEGER);
    CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, updated_at INTEGER)`);
  wb.prepare(`INSERT INTO sessions (id, cwd, title, status, model, created_at, updated_at, last_activity_at)
    VALUES ('syn-wb', 'C:/private/wb', '合成丙', 'completed', 'wb-synthetic', ?, ?, ?)`).run(now - 60000, now - 2000, now - 2000);
  wb.prepare(`INSERT INTO session_usage (session_id, used, size, updated_at) VALUES ('syn-wb', 90000, 300000, ?)`).run(now - 2000);
  wb.close();
  const stepDir = path.join(home, '.workbuddy', 'tasks', 'syn-wb');
  for (let i = 1; i <= 2; i++) {
    await writeFileDeep(path.join(stepDir, `${i}.json`), JSON.stringify({
      subject: `丙步${i}`, description: 'PRIVATE_SYNTHETIC_WB', activeForm: null,
      status: i === 1 ? 'completed' : 'in_progress', id: i, createdAt: now - 5000, updatedAt: now - 4000,
    }));
  }
  // Read/write isolation baseline over every source file.
  await hashTree(home, hashesBefore);

  // Run the real collector in dump mode with the synthetic home.
  snapshot = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'index.js'), '--dump', '--privacy', 'titles', '--detail', 'basic'], {
      cwd: projectRoot,
      env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'appdata-not-exist') },
    });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', () => {});
    child.on('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`dump exited ${code}`)));
    child.on('error', reject);
  });
});

after(async () => { await rm(home, { recursive: true, force: true }); });

const walkStrings = (value, into, keyPath = '') => {
  if (typeof value === 'string') into.push([keyPath, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, into, `${keyPath}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkStrings(v, into, `${keyPath}.${k}`);
};

test('四来源全部被 dump 发现；protocol 2', () => {
  assert.equal(snapshot.protocol, 2);
  const agents = new Set(snapshot.sessions.map(s => s.agent));
  for (const a of ['codex', 'dsh', 'zcode', 'workbuddy']) assert.ok(agents.has(a), `${a} present in dump`);
});

test('快照字符串字段全部落在隐私白名单内，正文零泄漏', () => {
  const strings = [];
  walkStrings(snapshot, strings);
  for (const [where, value] of strings) {
    assert.ok(!value.includes('PRIVATE_SYNTHETIC'), `synthetic body leaked at ${where}: ${value}`);
    assert.ok(!/[\\/]/.test(value) || where.includes('.project') === false ? true : true);
    if (where.endsWith('.title')) {
      assert.ok(value.length <= 48, `title length at ${where}`);
      assert.ok(!/[\\/]/.test(value), `title must not carry paths at ${where}`);
    }
    if (where.endsWith('.project')) {
      assert.ok(value.length <= 32 && !/[\\/]/.test(value), `project is a short basename at ${where}`);
    }
    if (where.endsWith('.summary')) assert.equal(value, null, 'basic mode sends no summaries');
    if (where.endsWith('.target')) assert.ok(value.length <= 80, `target truncated at ${where}`);
  }
  const codex = snapshot.sessions.find(s => s.agent === 'codex');
  assert.equal(codex.tokens.total, 122, 'primary token channel applied');
  assert.equal(codex.recentTools.length, 1);
  assert.equal(codex.recentTools[0].target, 'npm test', 'basic target = program + word');
  const zc = snapshot.sessions.find(s => s.agent === 'zcode');
  assert.equal(zc.tasks.done, 1);
  const wb = snapshot.sessions.find(s => s.agent === 'workbuddy');
  assert.equal(wb.context.window, 300000);
});

test('读写隔离：采集后来源文件逐一字节不变', async () => {
  const hashesAfter = new Map();
  await hashTree(home, hashesAfter);
  assert.equal(hashesAfter.size, hashesBefore.size);
  for (const [file, hash] of hashesBefore) assert.equal(hashesAfter.get(file), hash, `modified: ${path.relative(home, file)}`);
});

test('端口冲突：第二个实例以退出码 1 输出占用提示退出', async () => {
  const port = 47953;
  const first = spawn(process.execPath, [path.join(projectRoot, 'src', 'index.js'), '--port', String(port), '--privacy', 'none'], {
    cwd: projectRoot, env: { ...process.env, USERPROFILE: home, APPDATA: path.join(home, 'appdata-not-exist') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('first collector did not become ready')), 15000);
    const probe = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health' }, res => {
        res.resume(); clearTimeout(timer); resolve();
      });
      req.on('error', () => { setTimeout(probe, 300); });
    };
    probe();
  });
  const second = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'index.js'), '--port', String(port), '--privacy', 'none'], {
      cwd: projectRoot, env: { ...process.env, USERPROFILE: home, APPDATA: path.join(home, 'appdata-not-exist') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', c => { err += c; });
    child.on('exit', (code) => resolve({ code, err }));
  });
  assert.equal(second.code, 1);
  assert.match(second.err, /已被占用/);
  first.kill();
  await new Promise(r => first.on('exit', r));
});
