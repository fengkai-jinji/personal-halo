// Watcher boundary tests with a stub adapter: explicit record classification
// counters (ignored / unknown / parse errors), UTF-8 lines split across read
// chunks, file deletion → gone, and json-doc cursor dedup.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../src/store.js';
import { Watcher } from '../src/watch.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const stub = {
  id: 'stub', label: 'Stub', kind: 'jsonl',
  capabilities: ['state'],
  roots: () => [],
  match: file => file.endsWith('.jsonl') || file.endsWith('.doc.json'),
  kindOf: file => file.endsWith('.doc.json') ? 'json-doc' : 'jsonl',
  onRecord(rec, ctx) {
    if (rec.kind === 'ignored') return [];
    if (rec.kind === 'unknown') return null;
    if (rec.kind === 'meta') return [{ t: 'meta', sid: rec.sid, title: rec.title, at: ctx.now() }];
    return null;
  },
  onDocument(doc, cursor, ctx) {
    if (cursor === doc.rev) return { signals: [], cursor };
    return { signals: [{ t: 'meta', sid: doc.sid, title: doc.title, at: ctx.now() }], cursor: doc.rev };
  },
};

let home;
let root;
let store;
let watcher;
let config;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'personal-halo-watch-'));
  root = path.join(home, 'data');
  await rm(root, { force: true });
  await (await import('node:fs/promises')).mkdir(root, { recursive: true });
  config = { privacy: 'titles', detail: 'basic', visibleIdleMin: 600, maxSessions: 12, staleSec: 90, toolStaleSec: 900,
    adapters: { stub: { enabled: true, roots: [root] } } };
  store = new Store(config);
  watcher = new Watcher([stub], store, config);
  await watcher.start(false);
});
afterEach(async () => { await watcher.close(); store.close(); await rm(home, { recursive: true, force: true }); });

const health = () => watcher.health()[0];
const readAll = async () => {
  await Promise.all([...watcher.files.values()].map(entry => watcher.read(entry)));
  await sleep(50);
};

test('记录分类：ignored / unknown / parseErrors 三个计数器独立', async () => {
  await writeFile(path.join(root, 'a.jsonl'), [
    JSON.stringify({ kind: 'meta', sid: 's1', title: '甲' }),
    JSON.stringify({ kind: 'ignored' }),
    JSON.stringify({ kind: 'unknown' }),
    '{broken',
    JSON.stringify({ kind: 'ignored' }),
  ].join('\n') + '\n');
  for (const slot of watcher.roots) await watcher.discover(slot.owner, slot.root);
  await readAll();
  const h = health();
  assert.equal(h.ignoredRecords, 2);
  assert.equal(h.unknownRecords, 1);
  assert.equal(h.parseErrors, 1);
  assert.equal([...store.entries.values()][0].session.title, '甲');
});

test('UTF-8 半行跨块安全：多字节字符被截断后仍完整解析', async () => {
  const file = path.join(root, 'u.jsonl');
  // >64KB of padding so the file is read in many chunks; the emoji straddles a chunk boundary.
  const pad = 'x'.repeat(70000);
  await writeFile(file, `{"kind":"meta","sid":"s2","title":"甲${'🎉'.repeat(20)}乙","pad":"${pad}"}\n`);
  for (const slot of watcher.roots) await watcher.discover(slot.owner, slot.root);
  await readAll();
  const s = [...store.entries.values()].map(e => e.session).find(x => x.title?.includes('乙'));
  assert.ok(s, 'split multibyte line still parsed');
});

test('文件删除 → gone；json-doc 游标去重', async () => {
  const file = path.join(root, 'del.jsonl');
  await writeFile(file, JSON.stringify({ kind: 'meta', sid: 's3', title: '将删除' }) + '\n');
  const doc = path.join(root, 'd.doc.json');
  await writeFile(doc, JSON.stringify({ sid: 's4', title: '文档会话', rev: 1 }));
  for (const slot of watcher.roots) await watcher.discover(slot.owner, slot.root);
  await readAll();
  assert.ok([...store.entries.keys()].includes('stub:s3'));
  assert.ok([...store.entries.keys()].includes('stub:s4'));

  await rm(file);
  await writeFile(doc, JSON.stringify({ sid: 's4', title: '文档会话', rev: 1 })); // unchanged rev
  for (const slot of watcher.roots) await watcher.discover(slot.owner, slot.root);
  await readAll();
  assert.equal(store.entries.get('stub:s3'), undefined, 'deleted file → session removed');
  assert.ok(store.entries.get('stub:s4'), 'unchanged doc keeps session');

  await writeFile(doc, JSON.stringify({ sid: 's4', title: '文档会话2', rev: 2 }));
  for (const slot of watcher.roots) await watcher.discover(slot.owner, slot.root);
  await readAll();
  assert.equal(store.entries.get('stub:s4').session.title, '文档会话2', 'changed doc re-read');
});
