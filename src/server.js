// Derived from agent-halo (commit 4a22a69c6ad9) collector/src/server.js under
// PolyForm Noncommercial 1.0.0. Changes for personal-halo: protocol 2, the
// wildcard CORS header is removed (same-origin pages only: Host and Origin
// are both restricted), /health reports per-source readiness separately, and
// a read-only static file server rooted at public/ is added for the UI.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocol, version } from './store.js';

const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const staticTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(res, pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(publicRoot, relative === '' ? 'index.html' : relative);
  // Path traversal guard: the resolved path must stay inside public/.
  if (target !== publicRoot && !target.startsWith(publicRoot + path.sep)) return false;
  if (!existsSync(target) || !statSync(target).isFile()) return false;
  res.writeHead(200, { 'Content-Type': staticTypes[path.extname(target).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(target).pipe(res);
  return true;
}

export async function startServer(store, watcher, port) {
  const clients = new Set();
  let id = 0;
  const send = (res, event, data) => {
    if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
    res.write(`id: ${++id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Same-origin only: no CORS header is emitted, so other origins cannot read responses.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (code, value) => { res.writeHead(code); res.end(JSON.stringify(value)); };
    try {
      const actualPort = server.address().port;
      if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host)) return json(403, { error: 'Forbidden' });
      if (req.headers.origin) {
        try {
          const origin = new URL(req.headers.origin);
          if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.port !== String(actualPort)) {
            return json(403, { error: 'Forbidden' });
          }
        } catch { return json(403, { error: 'Forbidden' }); }
      }
      if (!['GET', 'OPTIONS'].includes(req.method)) { res.setHeader('Allow', 'GET, OPTIONS'); return json(405, { error: 'MethodNotAllowed' }); }
      if (req.method === 'OPTIONS') return json(200, {});
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      if (url.pathname === '/state') return json(200, store.snapshot());
      if (url.pathname === '/health') return json(200, {
        ok: true, protocol, version, uptimeSec: Math.floor((Date.now() - store.startedAt) / 1000),
        // Service readiness (ok) is separate from per-source readiness.
        sources: watcher.health(),
      });
      if (url.pathname !== '/events') {
        if (serveStatic(res, url.pathname)) return;
        return json(404, { error: 'NotFound' });
      }
      if (clients.size >= 8) return json(503, { error: 'ClientLimit' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      clients.add(res);
      res.write('retry: 2000\n\n');
      send(res, 'snapshot', store.snapshot());
      res.on('close', () => clients.delete(res));
      res.on('error', () => res.destroy());
    } catch { if (!res.headersSent) json(500, { error: 'RequestError' }); else res.destroy(); }
  });
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\n\r\n{}'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const listeners = new Map(['upsert','remove','pulse','totals','snapshot'].map(event => {
    const listener = data => { for (const res of clients) send(res, event, data); };
    store.on(event, listener);
    return [event, listener];
  }));
  const ping = setInterval(() => { for (const res of clients) send(res, 'ping', { now: Date.now() }); }, 15000).unref();
  return {
    port: server.address().port,
    async close() {
      clearInterval(ping);
      for (const [event, listener] of listeners) store.off(event, listener);
      for (const res of clients) res.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
