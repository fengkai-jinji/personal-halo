// Server boundary tests: Host/Origin restriction, method whitelist, health
// shape (protocol 2, service vs source readiness), SSE snapshot + client
// limit + reconnect, and the static file path traversal guard.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../src/server.js';
import { Store } from '../src/store.js';

let server;
let store;
const base = () => `127.0.0.1:${server.port}`;

function request(pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path: pathname, method, headers }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function sseConnect() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.port, path: '/events' }, res => {
      let buffer = '';
      res.on('data', c => { buffer += c; });
      resolve({ res, buffer: () => buffer, destroy: () => res.destroy() });
    });
    req.on('error', reject);
  });
}

beforeEach(async () => {
  store = new Store({ privacy: 'titles', detail: 'basic', visibleIdleMin: 600, maxSessions: 12, staleSec: 90, toolStaleSec: 900 });
  store.apply({ id: 'codex', label: 'Codex', capabilities: [] },
    { t: 'meta', sid: 's1', title: '合成会话', project: 'C:/private/demo/sub', model: 'synthetic', startedAt: Date.now() - 1000 });
  const fakeWatcher = { health: () => [{ id: 'codex', label: 'Codex', enabled: true, status: 'ok', watching: 1, sessions: 1, ignoredRecords: 0, unknownRecords: 0, parseErrors: 0, lastError: null }] };
  server = await startServer(store, fakeWatcher, 0);
});
afterEach(async () => { await server.close(); });

test('Host 校验与跨源 Origin 拒绝（不返回 CORS 头）', async () => {
  const evil = await request('/state', { headers: { Host: 'evil.example' } });
  assert.equal(evil.status, 403);
  const cross = await request('/state', { headers: { Origin: 'http://evil.example:1337' } });
  assert.equal(cross.status, 403);
  assert.equal(cross.headers['access-control-allow-origin'], undefined, 'no wildcard CORS header');
  const same = await request('/state', { headers: { Origin: `http://${base()}` } });
  assert.equal(same.status, 200);
  const localhost = await request('/state', { headers: { Host: `localhost:${server.port}` } });
  assert.equal(localhost.status, 200);
});

test('方法白名单：POST 405，OPTIONS 200', async () => {
  assert.equal((await request('/state', { method: 'POST' })).status, 405);
  assert.equal((await request('/state', { method: 'OPTIONS' })).status, 200);
});

test('/health 分报告服务与来源就绪；快照 protocol 2', async () => {
  const health = JSON.parse((await request('/health')).body);
  assert.equal(health.ok, true);
  assert.equal(health.protocol, 2);
  assert.ok(Array.isArray(health.sources) && health.sources[0].id === 'codex');
  assert.equal(health.sources[0].status, 'ok');
  const state = JSON.parse((await request('/state')).body);
  assert.equal(state.protocol, 2);
  assert.equal(state.sessions[0].title, '合成会话');
  assert.equal(state.sessions[0].project, 'sub');
});

test('SSE：先 retry+snapshot，断线重连拿新快照，8 客户端上限', async () => {
  const first = await sseConnect();
  await new Promise(r => setTimeout(r, 100));
  assert.match(first.buffer(), /retry: 2000/);
  assert.match(first.buffer(), /event: snapshot/);
  first.destroy();
  // Reconnect works after an unclean close.
  const second = await sseConnect();
  await new Promise(r => setTimeout(r, 100));
  assert.match(second.buffer(), /event: snapshot/);
  second.destroy();
  const clients = [];
  for (let i = 0; i < 8; i++) clients.push(await sseConnect());
  await new Promise(r => setTimeout(r, 150));
  const ninth = await request('/events');
  assert.equal(ninth.status, 503);
  for (const c of clients) c.destroy();
});

test('静态文件：仅 public/ 内可读，路径穿越与未知路径 404', async () => {
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'probe.html'), '<h1>halo</h1>');
  const ok = await request('/probe.html');
  assert.equal(ok.status, 200);
  assert.match(ok.body, /halo/);
  assert.match(ok.headers['content-type'], /text\/html/);
  for (const bad of ['/../package.json', '/..%2F..%2Fpackage.json', '/%5C..%5Cpackage.json', '/nope.js', '/src/store.js', '/']) {
    const res = await request(bad);
    if (bad === '/') assert.equal(res.status, 200, 'root serves index.html');
    else assert.equal(res.status, 404, `traversal/unknown blocked: ${bad}`);
  }
});
