// Derived from agent-halo (commit 4a22a69c6ad9) collector/src/watch.js under
// PolyForm Noncommercial 1.0.0. Changes for personal-halo: protocol 2 health
// separates ignoredRecords / unknownRecords / parseErrors per the revised
// design (explicit classification; unknown records are never swallowed).
import { watch as fsWatch } from 'node:fs';
import { stat, readdir, open, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseJSON, splitLines } from './util/jsonl.js';
import { clean } from './util/sanitize.js';
import { decompressFrames, decompressFramesLenient } from './util/zstd.js';

export class Watcher {
  constructor(adapters, store, config) {
    this.store = store;
    this.config = config;
    this.files = new Map();
    this.roots = [];
    this.closed = false;
    this.adapters = adapters.map(adapter => ({ adapter, shared: {},
      health: { id: adapter.id, label: adapter.label, enabled: config.adapters?.[adapter.id]?.enabled !== false && (!config.only || config.only.split(',').includes(adapter.id)),
        status: 'not-installed', watching: 0, sessions: 0,
        ignoredRecords: 0, unknownRecords: 0, parseErrors: 0, lastError: null } }));
  }

  error(owner, file, type) {
    if (type === 'UnknownRecord') owner.health.unknownRecords++;
    else owner.health.parseErrors++;
    owner.health.lastError = `${type} ${clean(path.basename(file), 100)}`;
    if (this.config.verbose) console.error(`${owner.adapter.id} ${owner.health.lastError}`);
  }

  context(entry, mtime) {
    const { owner, file } = entry;
    return { file, state: entry.state, shared: owner.shared, detail: this.config.detail, mtime,
      now: Date.now, cutoff: Date.now() - this.config.visibleIdleMin * 60000,
      hasSession: sid => this.store.entries.has(`${owner.adapter.id}:${sid}`),
      fail: type => this.error(owner, file, type) };
  }

  accept(entry, signals, countEmpty = false) {
    if (signals === null) { this.error(entry.owner, entry.file, 'UnknownRecord'); return; }
    if (countEmpty && Array.isArray(signals) && signals.length === 0) entry.owner.health.ignoredRecords++;
    for (const signal of signals) {
      if (!entry.owner.adapter.auxiliary?.(entry.file)) entry.sids.add(signal.sid);
      this.store.apply(entry.owner.adapter, signal);
    }
  }

  line(entry, line, ctx) {
    globalThis.__haloLines = (globalThis.__haloLines ?? 0) + 1;
    globalThis.__haloLastLine = String(line).slice(0, 80);
    const record = parseJSON(line, ctx.fail);
    if (record === undefined) return;
    // The record boundary also contains malformed field shapes; no raw error message escapes.
    try { this.accept(entry, entry.owner.adapter.onRecord(record, ctx), true); }
    catch { ctx.fail('RecordShape'); }
  }

  async read(entry) {
    const { file, owner } = entry;
    const adapter = owner.adapter;
    try {
      const info = await stat(file);
      if (!info.isFile()) return;
      let mtime = info.mtimeMs;
      if (entry.kind === 'sqlite') {
        try { mtime = Math.max(mtime, (await stat(file + '-wal')).mtimeMs); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (entry.mtime === mtime && entry.size === info.size) return;
      entry.observedMtime = mtime; entry.observedSize = info.size;
      const truncated = entry.size !== undefined && info.size < entry.size;
      if (truncated && !['sqlite','json-doc'].includes(entry.kind)) {
        this.removeSessions(entry); entry.state = {}; entry.offset = 0; entry.lines = 0; entry.partial = null;
      }
      const ctx = this.context(entry, mtime);
      if (entry.kind === 'mtime' || entry.kind === 'sqlite') {
        this.accept(entry, await adapter.poll(ctx));
      } else if (entry.kind === 'json-doc') {
        const doc = parseJSON(await readFile(file, { encoding: 'utf8', flag: 'r' }), ctx.fail);
        if (doc !== undefined) {
          const result = adapter.onDocument(doc, entry.cursor, ctx);
          this.accept(entry, result.signals); entry.cursor = result.cursor;
        }
      } else if (entry.kind === 'zstd-jsonl') {
        const raw = await readFile(file, { flag: 'r' });
        let data;
        try {
          data = decompressFrames(raw);
        } catch {
          // Torn or malformed trailing frames are expected while the source
          // appends; keep the complete-frame prefix and surface skipped tails.
          const lenient = decompressFramesLenient(raw);
          if (lenient.droppedTail) ctx.fail('ZstdIncomplete');
          data = lenient.data;
        }
        let lineCount = 0;
        splitLines(data, {}, line => { if (lineCount++ >= entry.lines) this.line(entry, line, ctx); });
        entry.lines = lineCount;
      } else {
        const handle = await open(file, 'r');
        try {
          let skip = entry.offset === 0 && info.size > 8 * 1024 * 1024;
          const buffer = Buffer.allocUnsafe(64 * 1024);
          if (skip) {
            // The first record carries the session's title and cwd, so keep it when skipping history.
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const end = buffer.subarray(0, bytesRead).indexOf(10);
            if (end > 0) this.line(entry, buffer.subarray(0, end).toString('utf8'), ctx);
            entry.offset = info.size - 1024 * 1024;
          }
          while (entry.offset < info.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - entry.offset), entry.offset);
            if (!bytesRead) break;
            entry.offset += bytesRead;
            let chunk = buffer.subarray(0, bytesRead);
            if (skip) {
              const end = chunk.indexOf(10);
              if (end === -1) continue;
              chunk = chunk.subarray(end + 1); skip = false;
            }
            splitLines(chunk, entry, line => this.line(entry, line, ctx));
          }
        } finally { await handle.close(); }
      }
      entry.mtime = mtime; entry.size = info.size; entry.lastRead = Date.now();
      owner.health.status = 'ok';
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.removeSessions(entry); this.files.delete(file);
      } else {
        this.error(owner, file, error.code ?? error.name);
        owner.health.status = 'error';
        // A failed parse/busy DB is retried only when the source changes again.
        entry.mtime = entry.observedMtime; entry.size = entry.observedSize;
      }
    }
  }

  removeSessions(entry) {
    for (const sid of entry.sids) {
      const other = [...this.files.values()].some(e => e !== entry && e.owner === entry.owner && e.sids.has(sid));
      if (!other) this.store.apply(entry.owner.adapter, { t: 'gone', sid });
    }
    entry.sids.clear();
  }

  async discover(owner, root, startup = false) {
    const adapter = owner.adapter;
    try {
      const info = await stat(root);
      owner.health.status = 'ok';
      if (info.isDirectory()) {
        let dirs = [root];
        if (adapter.dated && path.basename(root) === 'sessions') {
          dirs = [0, 1].map(days => {
            const date = new Date(Date.now() - days * 86400000);
            return path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
          });
        }
        for (const dir of dirs) {
          if (dir !== root) { await this.discover(owner, dir, startup); continue; }
          const children = await readdir(dir, { withFileTypes: true });
          // Primary transcripts precede sidecars, which may only enrich existing sessions.
          children.sort((a, b) => Number(adapter.auxiliary?.(a.name) ?? false) - Number(adapter.auxiliary?.(b.name) ?? false));
          for (const child of children) if (!child.isSymbolicLink()) await this.discover(owner, path.join(dir, child.name), startup);
        }
      } else if (adapter.match(root)) {
        if (adapter.prefer && !(await adapter.prefer(root))) return;
        let modified = info.mtimeMs;
        if (adapter.kind === 'sqlite') {
          try { modified = Math.max(modified, (await stat(root + '-wal')).mtimeMs); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const sidecarNeeded = adapter.auxiliary?.(root) && (path.basename(root) === 'session_index.jsonl' || this.store.entries.has(`${adapter.id}:${adapter.sessionIdOf(root)}`));
        // sqlite 容器长期监控：db 文件 mtime 停滞不代表没有近期会话（如 WorkBuddy 关闭后 db 不再更新，
        // 但其内的近期会话仍应在可见窗口内）；会话级可见性由 store.visible 按会话活动时间判定。
        const container = adapter.kind === 'sqlite';
        if (modified < Date.now() - this.config.visibleIdleMin * 60000 && !sidecarNeeded && !container) return;
        owner.health.status = 'ok';
        if (!this.files.has(root)) {
          const entry = { owner, file: root, kind: adapter.kindOf?.(root) ?? adapter.kind, state: {}, sids: new Set(), offset: 0, lines: 0, lastRead: 0 };
          this.files.set(root, entry);
          if (this.config.verbose) console.error(`${adapter.id} ${clean(path.basename(root), 100)}`);
          if (startup) await this.read(entry); else this.schedule(entry);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.error(owner, root, error.code ?? error.name); owner.health.status = 'error'; }
    }
  }

  schedule(entry) {
    if (this.closed) return;
    clearTimeout(entry.timer);
    const interval = { 'json-doc': 1500, 'zstd-jsonl': 3000, sqlite: 1000 }[entry.kind] ?? 0;
    const wait = Math.max(100, entry.lastRead + interval - Date.now());
    entry.timer = setTimeout(() => {
      entry.pending = (entry.pending ?? Promise.resolve()).then(() => this.read(entry));
    }, wait).unref();
  }

  async start(live = true) {
    this.store.silent = true;
    for (const owner of this.adapters) if (owner.health.enabled) {
      const configured = this.config.adapters?.[owner.adapter.id]?.roots;
      for (const root of configured?.length ? configured : owner.adapter.roots(os.homedir(), process.env)) {
        const absolute = path.resolve(root);
        await this.discover(owner, absolute, true);
        const slot = { owner, root: absolute, watcher: null, isFile: false };
        try { slot.isFile = (await stat(absolute)).isFile(); } catch {}
        this.roots.push(slot);
        if (live) this.attach(slot);
      }
    }
    this.store.tick(); this.store.silent = false; this.store.flush();
    if (live) {
      this.fallback = setInterval(() => {
        this.ticks = (this.ticks ?? 0) + 1;
        for (const entry of this.files.values()) {
          const watched = this.roots.some(r => r.owner === entry.owner && r.watcher);
          if (!watched || this.ticks % 5 === 0) this.schedule(entry);
        }
        if (this.ticks % 15 === 0) for (const slot of this.roots) if (!slot.watcher) {
          void this.discover(slot.owner, slot.root).then(() => this.attach(slot));
        }
      }, 2000).unref();
    }
  }

  attach(slot) {
    try {
      slot.watcher = fsWatch(slot.root, { recursive: true }, (_event, name) => {
        const file = slot.isFile ? slot.root : path.join(slot.root, name?.toString() ?? '');
        const normalized = file.endsWith('.db-wal') ? file.slice(0, -4) : file;
        const entry = this.files.get(normalized);
        if (entry) this.schedule(entry);
        else void this.discover(slot.owner, normalized);
      });
      slot.watcher.on('error', error => {
        slot.watcher.close(); slot.watcher = null;
        this.error(slot.owner, slot.root, error.code ?? error.name);
      });
    } catch (error) {
      if (error.code !== 'ENOENT') this.error(slot.owner, slot.root, error.code ?? error.name);
    }
  }

  health() {
    const visible = this.store.visible();
    return this.adapters.map(owner => ({ ...owner.health,
      watching: [...this.files.values()].filter(e => e.owner === owner).length,
      files: [...this.files.values()].filter(e => e.owner === owner).map(e => e.file.replace(/^\w:/, '')),
      sessions: visible.filter(s => s.agent === owner.adapter.id).length }));
  }

  async close() {
    this.closed = true; clearInterval(this.fallback);
    for (const r of this.roots) r.watcher?.close();
    for (const e of this.files.values()) clearTimeout(e.timer);
    await Promise.all([...this.files.values()].map(e => e.pending));
  }
}
