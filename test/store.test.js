// Store state-machine boundaries carried over from the agent-halo skeleton,
// re-verified for personal-halo: anonymous tool FIFO pairing, token baseline
// (first cumulative and channel switch produce no tps spike), task windows
// with cancelled items, expiry deleting whole entries, revive with fresh
// stats, and privacy=none clearing titles.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store.js';

const adapter = { id: 'codex', label: 'Codex', capabilities: ['state'] };
const config = { privacy: 'titles', detail: 'basic', visibleIdleMin: 600, maxSessions: 12, staleSec: 90, toolStaleSec: 900 };
const now = Date.now();
const at = ms => now - 9000 + ms;

test('无 callId 工具按 FIFO 配对；并行有 id 工具互不干扰', () => {
  const store = new Store(config);
  store.apply(adapter, { t: 'turn_start', sid: 's', at: at(0) });
  store.apply(adapter, { t: 'tool_start', sid: 's', at: at(1), tool: 'A' });
  store.apply(adapter, { t: 'tool_start', sid: 's', at: at(2), tool: 'B', callId: 'b' });
  store.apply(adapter, { t: 'tool_start', sid: 's', at: at(3), tool: 'C' });
  const s = [...store.entries.values()][0].session;
  assert.equal(s.toolCalls, 3);
  assert.equal(s.currentTool.name, 'C', 'latest open call is current');
  store.apply(adapter, { t: 'tool_end', sid: 's', at: at(4), ok: true });           // FIFO → A
  store.apply(adapter, { t: 'tool_end', sid: 's', at: at(5), callId: 'b', ok: false });
  store.apply(adapter, { t: 'tool_end', sid: 's', at: at(6), ok: true });           // FIFO → C
  assert.equal(s.toolErrors, 1);
  assert.ok(s.recentTools.every(t => t.ok !== null));
  store.close();
});

test('累计检查点间隔均速：Δoutput/Δ(completed_at)；首读/微小/超长间隔/非正增量不计算', () => {
  const store = new Store(config);
  store.apply(adapter, { t: 'turn_start', sid: 's', at: at(0) });
  // 首次读数：仅基线，无速率（重启后也不重放历史）
  store.apply(adapter, { t: 'tokens', sid: 's', at: at(0), input: 100, output: 10, mode: 'cumulative' });
  let s = [...store.entries.values()][0].session;
  assert.ok(!s.rate, 'first cumulative reading sets no rate');
  // 相邻读数 Δoutput=90 / Δt=30s → 3 tok/s 检查点均速（源时间差分）
  store.apply(adapter, { t: 'tokens', sid: 's', at: at(30000), input: 200, output: 100, mode: 'cumulative' });
  s = [...store.entries.values()][0].session;
  assert.equal(s.rate?.kind, 'checkpoint');
  assert.equal(Math.round(s.rate.tps * 10) / 10, 3, '90 output over 30s = 3 tok/s');
  assert.ok(s.rate.srcAt > 0, 'source timestamp kept for honest labeling');
  // 间隔 <1s：跳过（保留上一速率，避免除零尖峰）
  store.apply(adapter, { t: 'tokens', sid: 's', at: at(30500), input: 210, output: 105, mode: 'cumulative' });
  s = [...store.entries.values()][0].session;
  assert.equal(s.rate.tps, 3, 'tiny interval skipped');
  // 间隔 >30min：跳过（间隔过长无意义）
  store.apply(adapter, { t: 'tokens', sid: 's', at: at(30000 + 31 * 60000), input: 300, output: 200, mode: 'cumulative' });
  s = [...store.entries.values()][0].session;
  assert.equal(s.rate.tps, 3, 'oversized interval skipped');
  // Δoutput≤0：跳过
  store.apply(adapter, { t: 'tokens', sid: 's', at: at(30000 + 32 * 60000), input: 300, output: 200, mode: 'cumulative' });
  s = [...store.entries.values()][0].session;
  assert.equal(s.rate.tps, 3, 'non-positive delta skipped');
  store.close();
});

test('token 语义：累计回填只更新总量不产生速率；仅显式流式增量进滑窗', () => {
  const store = new Store(config);
  const pulses = [];
  store.on('pulse', event => pulses.push(...event.pulses));
  store.apply(adapter, { t: 'turn_start', sid: 's', at: at(0) });
  // Completion backfills (cumulative) never create streaming rate.
  store.apply(adapter, { t: 'tokens', sid: 's', at: at(1), input: 100, output: 10, total: 110, mode: 'cumulative' });
  let s = [...store.entries.values()][0].session;
  assert.equal(s.tokens.output, 10);
  assert.equal(s.tps, null, 'cumulative baseline: no rate');
  store.apply(adapter, { t: 'tokens', sid: 's', at: at(2), input: 200, output: 30, total: 230, mode: 'cumulative' });
  store.apply(adapter, { t: 'tokens', sid: 's', at: at(3), input: 260, output: 60, total: 320, mode: 'cumulative' });
  s = [...store.entries.values()][0].session;
  assert.equal(s.tokens.output, 60, 'totals still update from backfills');
  assert.equal(s.tps, null, 'multiple backfills must not fabricate tps');
  assert.ok(!pulses.some(p => p.kind === 'tokens' && p.tokensDelta !== undefined), 'no tokensDelta from backfills');
  // Non-streaming delta (message-end usage backfill) also stays out of the rate.
  store.apply(adapter, { t: 'tokens', sid: 's', at: at(4), output: 20, mode: 'delta' });
  s = [...store.entries.values()][0].session;
  assert.equal(s.tokens.output, 80);
  assert.equal(s.tps, null, 'unverified delta is not streaming');
  // Only explicitly verified streaming increments enter the sliding window.
  store.apply(adapter, { t: 'tokens', sid: 's', at: at(5), output: 30, mode: 'delta', streaming: true });
  s = [...store.entries.values()][0].session;
  assert.equal(s.tokens.output, 110);
  assert.equal(s.tps, 3, '30 streaming tokens over the 10s window');
  store.flush();
  assert.ok(pulses.some(p => p.kind === 'tokens' && p.tokensDelta === 30), 'streaming delta pulses');
  store.close();
});

test('任务窗口与取消项：取消项不发送但保留原始 index', () => {
  const store = new Store(config);
  store.apply(adapter, { t: 'turn_start', sid: 's', at: at(0) });
  const items = Array.from({ length: 14 }, (_, i) => ({ text: `step ${i}`, status: i < 10 ? 'done' : i === 10 ? 'active' : 'pending' }));
  items[12].status = 'cancelled';
  store.apply(adapter, { t: 'tasks', sid: 's', at: at(1), items });
  const s = [...store.entries.values()][0].session;
  assert.equal(s.tasks.done, 10);
  assert.equal(s.tasks.total, 13, 'cancelled excluded from total');
  assert.equal(s.tasks.items.length, 7, 'window = current-4 .. end; short tail allowed by design');
  assert.ok(s.tasks.items.every(i => i.text !== 'step 12'), 'cancelled item not sent');
  const active = s.tasks.items.find(i => i.status === 'active');
  assert.equal(active.index, 10, 'original index preserved');
  store.close();
});

test('过期删除整个 entry；复活后计数清零；privacy none 清标题', () => {
  let clock = { now: now + 120000 };
  const store = new Store(config, () => clock.now);
  store.apply({ ...adapter, id: 'zcode' }, { t: 'meta', sid: 's', title: '旧会话', at: now - 120000 });
  store.apply({ ...adapter, id: 'zcode' }, { t: 'tool_start', sid: 's', at: now - 119000, tool: 'Bash' });
  let entry = [...store.entries.values()][0];
  entry.session.state = 'idle'; entry.session.stateSince = now - 120000; entry.session.lastActivity = now - 120000;
  clock.now = now + 60 * 60 * 1000; // past visibleIdleMin(600min)? no — use explicit config below
  store.close();

  const tight = { ...config, visibleIdleMin: 1 };
  const store2 = new Store(tight, () => clock.now);
  store2.apply({ ...adapter, id: 'zcode' }, { t: 'meta', sid: 's', title: '旧会话', at: now - 120000 });
  store2.apply({ ...adapter, id: 'zcode' }, { t: 'tool_start', sid: 's', at: now - 119000, tool: 'Bash' });
  const e2 = [...store2.entries.values()][0];
  e2.session.state = 'idle'; e2.session.lastActivity = now - 120000;
  clock.now = now + 5 * 60 * 1000;
  store2.tick();
  assert.equal(store2.entries.size, 0, 'expired entry fully deleted');
  store2.apply({ ...adapter, id: 'zcode' }, { t: 'turn_start', sid: 's', at: clock.now });
  const revived = [...store2.entries.values()][0].session;
  assert.equal(revived.toolCalls, 0, 'revived session does not inherit old stats');
  store2.close();

  const store3 = new Store({ ...config, privacy: 'none' });
  store3.apply(adapter, { t: 'meta', sid: 's', title: '不该出现', project: 'C:/x/y', at: now });
  assert.equal([...store3.entries.values()][0].session.title, null);
  assert.equal([...store3.entries.values()][0].session.project, null);
  store3.close();
});
