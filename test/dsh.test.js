// DSH adapter tests. The adapter is copied from agent-halo; these tests verify
// the multi-frame v4 zstd decode through the copied util/zstd.js, v4-over-old
// preference, incremental appends, truncation reset and the conservative
// turn/end semantics — all with synthetic records (PRIVATE_SYNTHETIC markers).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const dsh = (await import('../src/adapters/dsh.js')).default;
import { Store } from '../src/store.js';
import { Watcher } from '../src/watch.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SID = '11112222-3333-4444-5555-666677778888';

let home;
const sessionsDir = () => path.join(home, '.dsh', 'sessions');
const sessionDir = () => path.join(sessionsDir(), `--C---private-demo--`, `session-${SID}`);
const v4file = () => path.join(sessionDir(), 'session.v4.jsonl.zstd');

function frame(record) {
  // One zstd frame per record mirrors the probed real writer behaviour.
  return zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8'));
}

const rec = (type, data, extra = {}) => ({ type, data, time: Date.now() - 5000, ...extra });

async function makeConfig() {
  return {
    privacy: 'titles', detail: 'basic', visibleIdleMin: 600, maxSessions: 12,
    staleSec: 90, toolStaleSec: 900,
    adapters: { dsh: { enabled: true, roots: [sessionsDir()] } },
  };
}

async function startWatcher(config) {
  const store = new Store(config);
  const watcher = new Watcher([dsh], store, config);
  await watcher.start(false);
  return { store, watcher };
}

const session = (store, sid = SID) => store.entries.get(`dsh:${sid}`)?.session;
const health = watcher => watcher.health()[0];
const readAll = async watcher => {
  await Promise.all([...watcher.files.values()].map(entry => watcher.read(entry)));
  await sleep(100);
};

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'personal-halo-dsh-'));
  await mkdir(sessionDir(), { recursive: true });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

test('多帧 v4 zstd 解码与事件映射（状态/token/context/任务/工具）', async () => {
  const frames = [
    frame(rec('session', { id: SID, cwd: 'C:/private/demo' })),
    frame(rec('session/title', { title: '合成标题甲（合成）' })),
    frame(rec('turn/start', { turn: 1 })),
    frame(rec('step/start', { turn: 1, step: 1 })),
    frame(rec('assistant/message', { message: { source: { model: 'deepseek-synthetic' }, content: [
      { type: 'reasoning', text: 'PRIVATE_SYNTHETIC_REASONING' },
      { type: 'text', text: 'PRIVATE_SYNTHETIC_BODY' },
    ] }, usage: { inputTokens: 1200, outputTokens: 300, reasoningTokens: 50, cacheReadTokens: 400, totalTokens: 1950 } })),
    frame({ type: 'todo/update', data: { todos: [{ content: '步骤甲', status: 'completed' }, { content: '步骤乙', status: 'in_progress' }, { content: '步骤丙', status: 'pending' }] }, time: Date.now() - 4900 }),
    frame(rec('tool/call', { callId: 'c1', name: 'Edit', arguments: '{"file_path":"a.js"}' })),
    frame(rec('tool/result', { message: { toolCallId: 'c1', isError: false } })),
    frame(rec('tool/call', { callId: 'c2', name: 'Bash', arguments: '{"command":"npm test"}' })),
    frame(rec('tool/result', { message: { toolCallId: 'c2', isError: true } })),
    frame(rec('turn/end', { turn: 1, reason: { kind: 'completed' } })),
  ];
  await writeFile(v4file(), Buffer.concat(frames));
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);

  const s = session(store);
  assert.ok(s, 'session created');
  assert.equal(s.title, '合成标题甲（合成）');
  assert.equal(s.model, 'deepseek-synthetic');
  assert.equal(s.turn, 1);
  assert.equal(s.toolCalls, 2);
  assert.equal(s.toolErrors, 1);
  // delta usage from assistant/message; context used = input + cacheRead
  assert.equal(s.tokens.input, 1200);
  assert.equal(s.tokens.output, 300);
  assert.equal(s.context.used, 1600);
  assert.deepEqual(s.tasks.items.map(i => i.text), ['步骤甲', '步骤乙', '步骤丙']);
  assert.deepEqual(s.tasks.items.map(i => i.status), ['done', 'active', 'pending']);
  assert.equal(s.tasks.done, 1);
  assert.equal(s.state, 'idle', 'turn/end completed → idle');
  const h = health(watcher);
  assert.equal(h.status, 'ok');
  assert.ok(!JSON.stringify(store.snapshot()).includes('PRIVATE_SYNTHETIC'));
  await watcher.close(); store.close();
});

test('v4 优先：同目录旧版 session.jsonl.zstd 被忽略，不重复计数', async () => {
  const frames = [
    frame(rec('session', { id: SID, cwd: 'C:/private/demo' })),
    frame(rec('turn/start', { turn: 1 })),
    frame(rec('turn/end', { turn: 1, reason: { kind: 'completed' } })),
  ];
  await writeFile(v4file(), Buffer.concat(frames));
  await writeFile(path.join(sessionDir(), 'session.jsonl.zstd'), Buffer.concat(frames));
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  assert.equal(session(store).turn, 1, 'old file ignored via prefer');
  assert.equal(health(watcher).watching, 1, 'only the v4 file is watched');
  await watcher.close(); store.close();
});

test('增量追加：新帧按行数游标续读', async () => {
  await writeFile(v4file(), Buffer.concat([
    frame(rec('session', { id: SID, cwd: 'C:/private/demo' })),
    frame(rec('turn/start', { turn: 1 })),
  ]));
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  assert.equal(session(store).turn, 1);

  await writeFile(v4file(), Buffer.concat([
    frame(rec('session', { id: SID, cwd: 'C:/private/demo' })),
    frame(rec('turn/start', { turn: 1 })),
    frame(rec('turn/end', { turn: 1, reason: { kind: 'completed' } })),
  ]));
  await readAll(watcher);
  assert.equal(session(store).state, 'idle', 'appended turn/end processed without recounting old lines');
  await watcher.close(); store.close();
});

test('turn/end 非 completed 按异常结束处理；损坏帧计 parseErrors', async () => {
  await writeFile(v4file(), Buffer.concat([
    frame(rec('session', { id: SID, cwd: 'C:/private/demo' })),
    frame(rec('turn/start', { turn: 1 })),
    frame(rec('turn/end', { turn: 1, reason: { kind: 'interrupted' } })),
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00]), // truncated zstd frame
  ]));
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  assert.equal(session(store).state, 'error');
  const h = health(watcher);
  assert.ok(h.parseErrors >= 1, `bad frame counted (parse=${h.parseErrors})`);
  await watcher.close(); store.close();
});

test('会话 id 取自父目录名（去 session- 前缀）', async () => {
  await writeFile(v4file(), Buffer.concat([frame(rec('session', { id: SID, cwd: 'C:/private/demo' }))]));
  const { store, watcher } = await startWatcher(await makeConfig());
  await readAll(watcher);
  assert.ok(session(store), 'session id derived from directory name');
  await watcher.close(); store.close();
});
