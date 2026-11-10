// Derived from agent-halo (commit 4a22a69c6ad9) collector/src/store.js under
// PolyForm Noncommercial 1.0.0. Changes for personal-halo: protocol 2 snapshot
// version marker. State machine, task stats and privacy handling unchanged.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { clean, basename } from './util/sanitize.js';

const windows = { 'claude-sonnet-4': 200000, 'claude-opus-4': 200000, 'gpt-5': 400000 };
export const version = '0.2.0';
export const protocol = 2;

export class Store extends EventEmitter {
  constructor(config, now = Date.now) {
    super();
    this.config = config;
    this.now = now;
    this.startedAt = now();
    this.entries = new Map();
    this.dirty = new Set();
    this.pulses = [];
    this.visibleKeys = new Set();
    this.toolTimes = [];
    this.lastTotals = '';
    this.silent = false;
  }

  apply(adapter, signal) {
    const key = `${adapter.id}:${signal.sid}`;
    if (signal.t === 'gone') {
      this.entries.delete(key);
      this.queue(key);
      return;
    }
    const at = signal.at ?? signal.startedAt ?? this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        session: {
          key, agent: adapter.id, agentLabel: adapter.label, title: null, project: null,
          model: null, parentKey: null, state: 'idle', stateSince: at, startedAt: at,
          lastActivity: at, turn: 0, step: 0, toolCalls: 0, toolErrors: 0,
          currentTool: null, recentTools: [], tasks: null,
          tokens: { input: null, output: null, reasoning: null, cacheRead: null, total: null },
          context: null, tps: null, capabilities: [...adapter.capabilities],
        },
        calls: new Map(), rates: [], hasRate: false,
        idleSec: this.config.adapters?.[adapter.id]?.idleSec ?? adapter.idleSec,
      };
      this.entries.set(key, entry);
    }
    const s = entry.session;
    const capability = { tool_start: 'tools', turn_start: 'turns', tokens: 'tokens', context: 'context', tasks: 'tasks' }[signal.t];
    if (capability && !s.capabilities.includes(capability)) s.capabilities.push(capability);
    s.lastActivity = Math.max(s.lastActivity, at);
    const state = value => {
      if (s.state !== value) { s.state = value; s.stateSince = at; }
    };
    const pulse = (kind, extra = {}) => {
      if (!this.silent) this.pulses.push({ key, kind, ...extra, at });
    };
    switch (signal.t) {
      case 'meta':
        if (this.config.privacy !== 'none') {
          if (signal.title !== undefined) s.title = clean(signal.title, 48);
          if (signal.project !== undefined) s.project = clean(basename(signal.project), 32);
        }
        if (signal.model !== undefined) s.model = clean(signal.model, 32);
        if (signal.parentSid) s.parentKey = `${adapter.id}:${signal.parentSid}`;
        if (signal.startedAt !== undefined) s.startedAt = signal.startedAt;
        break;
      case 'turn_start':
        entry.calls.clear();
        s.turn++; s.step = 0; s.currentTool = null; state('thinking'); pulse('turn_start');
        break;
      case 'thinking': state('thinking'); break;
      case 'text':
        state('streaming'); pulse('message');
        if (this.config.detail === 'full' && signal.snippet !== undefined) {
          entry.snippet = clean(signal.snippet, 120);
          for (const task of entry.plan?.items ?? []) if (task.item.status === 'active') task.snippet = entry.snippet;
        }
        if (signal.outTokens !== undefined) this.rate(entry, at, signal.outTokens);
        break;
      case 'activity':
        entry.idleSec ??= 20;
        state('streaming'); break;
      case 'tool_start': {
        const name = clean(signal.tool, 32);
        const target = clean(signal.target, 80);
        s.currentTool = { name, target, since: at };
        const recent = { name, target, ok: null, at };
        s.recentTools.unshift(recent);
        s.recentTools.length = Math.min(s.recentTools.length, 8);
        // Running calls outlive the eight-item history; anonymous calls finish FIFO.
        entry.calls.set(signal.callId ?? Symbol(), recent);
        s.step++; s.toolCalls++; state('tool'); pulse('tool_start', { tool: name });
        if (at >= this.now() - 60000) this.toolTimes.push(at);
        taskActivity(entry, 'tools', signal.files ?? []);
        break;
      }
      case 'tool_end': {
        const id = signal.callId ?? entry.calls.keys().next().value;
        const recent = entry.calls.get(id);
        if (recent) { recent.ok = signal.ok; entry.calls.delete(id); }
        const name = recent?.name ?? clean(signal.tool, 32);
        const running = [...entry.calls.values()].at(-1);
        s.currentTool = running ? { name: running.name, target: running.target, since: running.at } : null;
        state(running ? 'tool' : 'thinking');
        if (!signal.ok) { s.toolErrors++; taskActivity(entry, 'errors'); }
        pulse(signal.ok ? 'tool_end' : 'tool_error', name ? { tool: name } : {});
        break;
      }
      case 'waiting': state('waiting'); break;
      case 'turn_end':
        entry.calls.clear();
        s.currentTool = null; state(signal.ok ? 'idle' : 'error');
        pulse(signal.ok ? 'turn_end' : 'error');
        break;
      case 'tokens': {
        if (signal.mode === 'delta') {
          for (const field of Object.keys(s.tokens)) if (signal[field] !== undefined) {
            s.tokens[field] = (s.tokens[field] ?? 0) + signal[field];
          }
          // Only verified streaming increments drive the rate and the pulse;
          // message-end usage backfills update totals without either.
          if (signal.streaming) {
            const count = signal.output ?? 0;
            this.rate(entry, at, count);
            pulse('tokens', { tokensDelta: count });
          } else pulse('tokens', {});
        } else {
          // Cumulative readings are completion backfills / channel snapshots:
          // totals update, but they must never fabricate a streaming rate.
          for (const field of Object.keys(s.tokens)) if (signal[field] !== undefined) {
            s.tokens[field] = signal[field];
          }
          // Consecutive cumulative readings with source timestamps yield a
          // verifiable interval average: Δoutput / Δ(completed_at). First
          // reading, tiny/oversized intervals and non-positive deltas are
          // skipped — nothing is extrapolated over session lifetime.
          const prevCum = entry.lastCum;
          const curOut = s.tokens.output ?? 0;
          if (prevCum && curOut > prevCum.output) {
            const dtMs = at - prevCum.at;
            if (dtMs >= 1000 && dtMs <= 30 * 60000) {
              s.rate = { kind: 'checkpoint', tps: (curOut - prevCum.output) / (dtMs / 1000), srcAt: at, at: this.now() };
            }
          }
          entry.lastCum = { output: curOut, at };
          pulse('tokens', {});
        }
        break;
      }
      case 'context': {
        const window = signal.window ?? s.context?.window ?? entry.window ?? windows[s.model] ?? null;
        const used = signal.used ?? s.context?.used;
        if (used !== undefined) s.context = { used, window, ratio: window ? used / window : null };
        else entry.window = window;
        if (s.context && !s.context.window && entry.window) {
          s.context.window = entry.window; s.context.ratio = used / entry.window;
        }
        break;
      }
      case 'compact': pulse('compact'); break;
      case 'tasks': {
        if (updateTasks(entry, signal.items, at, this.config.detail)) pulse('task_done');
        break;
      }
    }
    this.queue(key);
  }

  rate(entry, at, count) {
    entry.hasRate = true;
    if (!entry.session.capabilities.includes('tps')) entry.session.capabilities.push('tps');
    if (at >= this.now() - 10000) {
      const bucket = Math.floor(at / 1000) * 1000;
      const recent = entry.rates.find(i => i.at === bucket);
      if (recent) recent.count += count;
      else entry.rates.push({ at: bucket, count });
    }
    this.updateRate(entry, this.now());
  }

  updateRate(entry, now) {
    entry.rates = entry.rates.filter(i => i.at > now - 10000);
    entry.session.tps = entry.hasRate ? entry.rates.reduce((sum, i) => sum + i.count, 0) / 10 : null;
  }

  visible() {
    const cutoff = this.now() - this.config.visibleIdleMin * 60000;
    return [...this.entries.values()].map(e => e.session)
      .filter(s => s.state !== 'idle' || s.lastActivity >= cutoff)
      .sort((a, b) => Number(b.state !== 'idle') - Number(a.state !== 'idle') || b.lastActivity - a.lastActivity)
      .slice(0, this.config.maxSessions).sort((a, b) => a.startedAt - b.startedAt);
  }

  totals(sessions = this.visible()) {
    this.toolTimes = this.toolTimes.filter(at => at > this.now() - 60000);
    return {
      running: sessions.filter(s => ['thinking','streaming','tool'].includes(s.state)).length,
      waiting: sessions.filter(s => s.state === 'waiting').length,
      tps: sessions.reduce((sum, s) => sum + (s.tps ?? 0), 0), toolsPerMin: this.toolTimes.length,
    };
  }

  snapshot() {
    const sessions = this.visible();
    return { protocol, collector: { version, startedAt: this.startedAt, now: this.now() }, sessions, totals: this.totals(sessions) };
  }

  queue(key) {
    this.dirty.add(key);
    if (!this.silent && !this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 250).unref();
  }

  flush() {
    clearTimeout(this.flushTimer); this.flushTimer = null;
    if (globalThis.__haloFlushDbg) console.error('[flush]', JSON.stringify({ entries: [...this.entries.keys()], visible: this.visible().map(v => v.key + ':' + v.state + ':' + Math.round(v.lastActivity)), cutoff: this.now() - this.config.visibleIdleMin * 60000, now: this.now() }));
    const sessions = this.visible();
    const keys = new Set(sessions.map(s => s.key));
    const removed = [...this.visibleKeys].filter(k => !keys.has(k));
    const changed = sessions.filter(s => this.dirty.has(s.key) || !this.visibleKeys.has(s.key));
    // Drop the whole entry, including task stats/snippets and running-call data.
    for (const key of this.entries.keys()) if (!keys.has(key)) this.entries.delete(key);
    if (removed.length) this.emit('remove', { keys: removed });
    if (changed.length) this.emit('upsert', { sessions: changed });
    const pulses = this.pulses.filter(p => keys.has(p.key)).sort((a, b) => a.at - b.at);
    if (pulses.length) this.emit('pulse', { pulses });
    const totals = this.totals(sessions);
    const encoded = JSON.stringify(totals);
    if (encoded !== this.lastTotals) this.emit('totals', totals);
    this.lastTotals = encoded;
    this.visibleKeys = keys; this.dirty.clear(); this.pulses = [];
  }

  tick() {
    const now = this.now();
    for (const [key, e] of this.entries) {
      const s = e.session;
      const elapsed = (now - s.lastActivity) / 1000;
      let next = s.state;
      if (e.idleSec && elapsed > e.idleSec) next = 'idle';
      else if (s.state === 'error' && now - s.stateSince >= 60000) next = 'idle';
      else if (['thinking','streaming'].includes(s.state) && elapsed > this.config.staleSec) next = 'waiting';
      else if (s.state === 'tool' && elapsed > this.config.toolStaleSec) next = 'waiting';
      if (next !== s.state) { s.state = next; s.stateSince = now; s.currentTool = null; e.calls.clear(); this.queue(key); }
      if (globalThis.__haloFlushDbg) console.error('[tick]', key, s.state, 'elapsed', Math.round(elapsed), 'idleSec', e.idleSec);
      if (s.state === 'idle' && elapsed > this.config.visibleIdleMin * 60) {
        this.entries.delete(key); this.queue(key); continue;
      }
      const before = s.tps;
      this.updateRate(e, now);
      if (before !== s.tps) this.queue(key);
    }
    const keys = this.visible().map(s => s.key);
    if (keys.length !== this.visibleKeys.size || keys.some(k => !this.visibleKeys.has(k)) || this.toolTimes.some(at => at <= now - 60000)) this.queue('');
  }

  start() {
    const run = () => { this.tick(); this.tickTimer = setTimeout(run, this.visible().length ? 1000 : 10000).unref(); };
    this.tickTimer = setTimeout(run, 1000).unref();
  }
  close() { clearTimeout(this.tickTimer); clearTimeout(this.flushTimer); }
}

const emptyActivity = () => ({ tools: 0, errors: 0, files: new Set() });
const newStats = at => ({ startedAt: at, endedAt: null, tools: 0, errors: 0, files: [], filesMore: 0 });

function taskActivity(entry, field, files = []) {
  const plan = entry.plan;
  if (!plan) return;
  const active = plan.items.find(t => t.item.status === 'active');
  // Unassigned activity belongs to the first directly completed step at the next update.
  const counts = active ? active.item.stats : plan.interval;
  counts[field]++;
  const names = active ? active.files : plan.interval.files;
  for (const file of files) names.add(clean(basename(file), 80));
  if (active) {
    counts.files = [...names].slice(0, 3);
    counts.filesMore = Math.max(0, names.size - 3);
  }
}

function updateTasks(entry, source, at, detail) {
  const occurrences = new Map();
  const incoming = source.map((item, index) => {
    // Match full text without retaining text beyond the privacy limit.
    const hash = createHash('sha256').update(item.text ?? '').digest('hex');
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    return { ...item, index, key: hash + ':' + occurrence };
  }).filter(i => i.status !== 'cancelled');
  let plan = entry.plan;
  const old = new Map((plan?.items ?? []).map(t => [t.key, t]));
  const overlap = incoming.filter(i => old.has(i.key)).length;
  const replaced = plan && overlap * 2 < Math.min(old.size, incoming.length);
  if (!plan || replaced || !incoming.length) {
    plan = { items: [], updatedAt: at, interval: emptyActivity() };
    old.clear(); entry.snippet = null;
  }
  let completed = false;
  let assigned = false;
  plan.items = incoming.map(i => {
    const task = old.get(i.key) ?? { key: i.key, item: { stats: null, summary: null }, files: new Set(), snippet: null };
    const previous = task.item.status;
    const item = task.item;
    item.index = i.index; item.text = clean(i.text, detail === 'full' ? 60 : 32); item.status = i.status;
    if (i.status === 'active' && previous !== 'active') {
      item.stats ??= newStats(at);
      item.stats.endedAt = null; item.summary = null;
    }
    if (i.status === 'done' && previous !== 'done') {
      completed = true;
      if (!item.stats) {
        item.stats = newStats(plan.updatedAt);
        if (!assigned) {
          item.stats.tools = plan.interval.tools; item.stats.errors = plan.interval.errors;
          task.files = new Set(plan.interval.files);
          item.stats.files = [...task.files].slice(0, 3);
          item.stats.filesMore = Math.max(0, task.files.size - 3);
          assigned = true;
        }
      }
      item.stats.endedAt = at;
      item.summary = detail === 'full' ? task.snippet : null;
    }
    return task;
  });
  plan.updatedAt = at; plan.interval = emptyActivity(); entry.plan = plan;
  const items = plan.items.map(t => t.item);
  let current = items.findIndex(i => i.status === 'active');
  if (current < 0) current = items.findIndex(i => i.status === 'pending');
  const next = current < 0 ? null : items.slice(current + 1).find(i => i.status === 'pending');
  const start = Math.max(0, current < 0 ? items.length - 12 : current - 4);
  entry.session.tasks = {
    done: items.filter(i => i.status === 'done').length, total: items.length,
    current: current < 0 ? null : { index: items[current].index, text: items[current].text },
    next: next ? { text: next.text } : null,
    items: items.slice(start, start + 12), updatedAt: at,
  };
  return completed;
}
