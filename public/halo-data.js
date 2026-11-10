/* personal-halo 数据客户端（前置加载）：SSE /state //events /health → AGT 形状映射。
 * 本文件在 concentric.js 之前加载，确保 haloState 等在引擎代码执行时已可用。 */
window.__errs3 = window.__errs3 || [];
window.addEventListener('error', e => window.__errs3.push(e.message + ' @ L' + e.lineno));
/* =========================================================
   personal-halo 数据客户端（采集器 /state //events /health）
   会话映射为 AGT renderSlot 所需形状；口径保持 B 阶段语义。
   ========================================================= */
const haloState = { sessions: new Map(), totals: { running: 0 }, sources: [], status: 'connecting', at: 0 };
const haloAgents = ['codex', 'dsh', 'zcode', 'workbuddy'];
const haloAgentLabel = { codex: 'Codex', dsh: 'DeepSeek', zcode: 'ZCode', workbuddy: 'WorkBuddy' };
function haloRatePresentation(sessions) {
  const active = sessions.filter(s => ['thinking','streaming','tool'].includes(s.state));
  const sampled = active.find(s => typeof s.tps === 'number' && Number.isFinite(s.tps) && s.tps > 0);
  if (sampled) return { text: `${haloAgentLabel[sampled.agent]} ${sampled.tps.toFixed(1)} tok/s`, live: true, hint: '实时输出：采集器已验证的流式增量，10 秒窗口；不是请求平均速率。' };
  if (!active.length) return { text: '当前无执行任务', live: false, hint: '没有执行中的会话，不展示历史速率。' };
  // 检查点间隔均速：相邻两次完成用量检查点（completed_at）的 Δoutput / Δt，
  // 由采集器在 store 侧计算（src/store.js）。诚实标注「≈ 近段均速」，不是逐 token 实时速率。
  const ckpt = active.find(s => s.rate?.kind === 'checkpoint' && s.rate.tps > 0);
  if (ckpt) {
    const hm = (() => { const t = new Date(ckpt.rate.at); return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); })();
    const base = `${haloAgentLabel[ckpt.agent] ?? ckpt.agent} ≈ 近段均速 ${ckpt.rate.tps.toFixed(1)} tok/s`;
    const hint = '口径：相邻两次完成用量检查点（completed_at）之间的输出增量 ÷ 间隔；不是逐 token 实时速率。';
    if (Date.now() - ckpt.rate.at > 10 * 60000) return { text: `${base}（${hm} 已过期）`, live: false, hint, className: 'wait' };
    return { text: `${base} · ${hm}`, live: false, hint, className: 'avg' };
  }
  if (active.some(s => s.capabilities?.includes('tps'))) return { text: '等待流式增量', live: false, hint: '来源支持流式速率，当前没有有效窗口样本。' };
  return { text: '来源未提供实时速率', live: false, hint: '当前来源按请求回填累计用量，没有逐 token 时间数据；累计输出不能换算成实时 tok/s。' };
}
function haloInnerNodeLayout(nodes, radius) {
  const sources = haloAgents.filter(agent => nodes.some(n => n.source === agent));
  const positions = new Map();
  for (const node of nodes) {
    const lane = sources.indexOf(node.source), y = ((lane + .5) / Math.max(1, sources.length) - .5) * radius * 1.12;
    const peers = nodes.filter(n => n.source === node.source && n.kind === node.kind).sort((a,b) => a.id.localeCompare(b.id));
    const offset = (peers.findIndex(n => n.id === node.id) - (peers.length - 1) / 2) * Math.min(26, radius * .16 / Math.max(1, peers.length));
    positions.set(node.id, { x: radius * (node.kind === 'source' ? .10 : node.kind === 'session' ? .52 : .30), y: y + offset + (node.kind === 'tool' ? radius * .11 : 0) });
  }
  return positions;
}
window.haloSelectedKey = null;
window.haloAutoFollow = true;
window.haloPrevRunningSig = '';
window.haloFollowIdx = 0;
window.haloVisibleAgents = new Set(['codex', 'dsh', 'zcode', 'workbuddy']);
const STATE_TO_AGTF = { thinking: 'running', streaming: 'running', tool: 'running', waiting: 'unknown', error: 'failed', idle: 'idle' };
function haloSessionShape(s) {
  return {
    source: s.agent, id: s.key,
    title: s.title || s.project || '（无标题会话）',
    model: s.model || '未提供',
    status: STATE_TO_AGTF[s.state] ?? 'unknown',
    // WorkBuddy 等来源 tokens=null/{}（新会话尚无用量事件）：显示「未提供」而不是伪造 0
    hasTokens: ['input','output','cacheRead'].some(k => typeof s.tokens?.[k] === 'number' && Number.isFinite(s.tokens[k])),
    inputTokens: typeof s.tokens?.input === 'number' && Number.isFinite(s.tokens.input) ? s.tokens.input : null,
    outputTokens: typeof s.tokens?.output === 'number' && Number.isFinite(s.tokens.output) ? s.tokens.output : null,
    cachedTokens: typeof s.tokens?.cacheRead === 'number' && Number.isFinite(s.tokens.cacheRead) ? s.tokens.cacheRead : null,
    contextTokens: s.context?.used ?? 0, contextWindow: s.context?.window ?? 0,
    parentId: s.parentKey ?? null, isSubagent: false,
    lastTool: s.currentTool?.name ?? null, lastAt: (s.lastActivity ?? 0) / 1000,
    tools: (s.recentTools ?? []).map(t => ({ name: t.name, calls: 1, status: t.ok === false ? 'failed' : 'completed', durationMs: null })),
    usageSamples: [], cwd: s.project ?? '',
    rate: s.rate ?? null,   // {kind:'checkpoint', tps, srcAt, at} 检查点间隔均速
    state: s.state, lastActivity: s.lastActivity ?? 0, toolCalls: s.toolCalls, toolErrors: s.toolErrors,
    tasks: s.tasks ?? null,
  };
}
function haloSessionsOf(agent) {
  const out = [];
  for (const s of haloState.sessions.values()) if (s.agent === agent) out.push(haloSessionShape(s));
  return out.sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.lastAt - a.lastAt);
}
function haloRingActivity(agent) {
  let n = 0;
  for (const s of haloState.sessions.values()) if (s.agent === agent && (s.state === 'thinking' || s.state === 'streaming' || s.state === 'tool')) n++;
  return Math.min(1, 0.18 + n * 0.4);
}
function haloEmptyText(agent) {
  return agent === 'dsh' ? '无近期记录 · 待实机验收' : agent === 'workbuddy' ? '无近期记录 · 步骤快照待验' : '无近期记录';
}
window.haloHitTest = (px, py) => {
  for (let i = RINGS.length - 1; i >= 0; i--) {
    const st = RINGS[i];
    const d = Math.hypot(px - cx, py - cy);
    if (d >= st.R - 6 && d <= st.RO + 10) {
      const a = Math.atan2(py - cy, px - cx);
      let best = null, bd = 9;
      for (const sl of st.slots) { const dd = Math.abs(normA(sl.a + st.ringRot - a)); if (dd < bd) { bd = dd; best = sl; } }
      const binding = best ? taskSceneState.ringBindings.get(best) : null;
      return { ring: i, agent: st.id, slot: best, session: binding?.session ?? null };
    }
  }
  return null;
};
function haloApplySnapshot(snap) {
  haloState.sessions.clear();
  for (const s of snap.sessions ?? []) haloState.sessions.set(s.key, s);
  haloState.totals = snap.totals ?? { running: 0 };
  haloState.at = snap.collector?.now ?? Date.now();
  // 统一数据路径：同一份会话同时供给 AGT 引擎（环带卡片/底部仪器/镜头跟随）
  agtState.snapshot = {
    sessions: [...haloState.sessions.values()].map(haloSessionShape),
    totals: {
      running: snap.totals?.running ?? 0,
      outputTokens: [...haloState.sessions.values()].reduce((a, s) => a + (s.tokens?.output ?? 0), 0),
    },
    sources: haloAgents.map(a => {
      const sess = [...haloState.sessions.values()].filter(x => x.agent === a);
      return {
        id: a, status: 'ok', sessions: sess.length,
        online: sess.some(x => x.state !== 'idle'),
        running: sess.filter(x => ['thinking', 'streaming', 'tool'].includes(x.state)).length,
      };
    }),
    events: [], at: Date.now() / 1000,
    topology: (() => {
      // 内场任务网络：只用真实已知关系（来源→会话→运行中工具；parentKey 父子）
      const nodes = [], edges = [], seenSrc = new Set();
      const sess = [...haloState.sessions.values()];
      const run = x => ['thinking', 'streaming', 'tool'].includes(x.state);
      sess.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
      for (const x of sess.slice(0, 8)) {
        if (!seenSrc.has(x.agent)) { seenSrc.add(x.agent); nodes.push({ id: 'src:' + x.agent, source: x.agent, kind: 'source', label: haloAgentLabel[x.agent] ?? x.agent, status: 'running' }); }
        nodes.push({ id: 'sess:' + x.key, source: x.agent, kind: 'session', sessionId: x.key, label: (x.title || '(无标题)').slice(0, 18), status: x.state });
        edges.push({ id: 'e:ss:' + x.key, from: 'src:' + x.agent, to: 'sess:' + x.key, source: x.agent, sessionId: x.key, kind: 'source-session' });
        if (x.parentKey && haloState.sessions.has(x.parentKey)) edges.push({ id: 'e:pc:' + x.key, from: 'sess:' + x.parentKey, to: 'sess:' + x.key, source: x.agent, sessionId: x.key, kind: 'parent-child' });
        const tool = x.currentTool?.name;
        if (tool && run(x)) {
          nodes.push({ id: 'tool:' + x.key + ':' + tool, source: x.agent, kind: 'tool', sessionId: x.key, label: (typeof toolLabel === 'function' ? toolLabel(tool) : tool), status: 'running' });
          edges.push({ id: 'e:st:' + x.key + ':' + tool, from: 'sess:' + x.key, to: 'tool:' + x.key + ':' + tool, source: x.agent, sessionId: x.key, kind: 'session-tool' });
        }
      }
      return { nodes, edges };
    })(),
  };
  haloState.sources = agtState.snapshot.sources;   // drawDiff 来源面板与引擎同源
  if (typeof agtMarkPanelsDirty === 'function') agtMarkPanelsDirty();   // monitor 模式下 diff/idx 仅脏标记时重绘
  // 数据带脏标记 + 事件爆发
  const stamps = new Map([...haloState.sessions.values()].map(s => [s.key, JSON.stringify([s.title, s.model, s.state, s.tokens, s.currentTool, s.lastActivity])]));
  withRingEach(st => {
    for (const slot of st.slots) {
      const b = taskSceneState.ringBindings.get(slot);
      const stamp = b?.session ? (stamps.get(b.session.id) ?? 'x') : 'ring:' + st.id + '|empty';
      if (slot.telemetryStamp !== stamp) { slot.telemetryStamp = stamp; slot.dirty = true; }
    }
  });
  if (typeof haloOnSnapshot === 'function') haloOnSnapshot(snap);
}
function haloConnect() {
  const es = new EventSource('/events');
  let retry = 2000;
  es.addEventListener('snapshot', e => { retry = 2000; haloStatus('live'); haloApplySnapshot(JSON.parse(e.data)); syncTaskScene(); });
  es.addEventListener('upsert', e => { const d = JSON.parse(e.data); for (const s of d.sessions ?? []) haloState.sessions.set(s.key, s); haloApplySnapshot({ sessions: [...haloState.sessions.values()], totals: haloState.totals, collector: { now: Date.now() } }); syncTaskScene(); });
  es.addEventListener('remove', e => { const d = JSON.parse(e.data); for (const k of d.keys ?? []) haloState.sessions.delete(k); });
  es.addEventListener('pulse', e => {
    const d = JSON.parse(e.data);
    for (const p of d.pulses ?? []) {
      if (p.kind !== 'tool_start' && p.kind !== 'tool_end' && p.kind !== 'tool_error') continue;
      const s = haloState.sessions.get(p.key); if (!s) continue;
      taskSceneState.bursts.push({ sessionId: s.key, source: s.agent, label: p.tool ?? p.kind, failed: p.kind === 'tool_error', life: 0 });
      if (taskSceneState.bursts.length > 12) taskSceneState.bursts.shift();
    }
    if (typeof haloOnPulse === 'function') haloOnPulse(d);
  });
  es.addEventListener('ping', () => { haloState.at = Date.now(); });
  es.onerror = () => {
    haloStatus('stale');
    es.close();
    setTimeout(haloConnect, retry); retry = Math.min(retry * 2, 30000);
  };
}
function haloStatus(st) {
  haloState.status = st;
  if (typeof haloOnStatus === 'function') haloOnStatus(st);
}
setInterval(() => { if (!document.hidden) { fetch('/health').then(r => r.json()).then(h => { if (typeof haloOnHealth === 'function') haloOnHealth(h); }).catch(() => {}); } }, 8000);
function haloWake() { last = performance.now(); if (typeof agtWakeRender === 'function') agtWakeRender(); }

/* ── 测试夹具：模拟 Codex+ZCode 同时运行（明确标注，不混入真实采集页）── */
function haloFixtureBoot() {
  document.title = '【夹具】Personal Halo — 模拟数据';
  const mk = (agent, key, title, state, model, ctxUsed, ctxWin, tin, tout, tc, tools) => ({
    key, agent, title, project: 'fixture', model, state,
    tokens: { input: tin, output: tout, cacheRead: tc }, context: { used: ctxUsed, window: ctxWin },
    currentTool: tools[0] ? { name: tools[0] } : null,
    recentTools: tools.map(n => ({ name: n })),
    lastActivity: Date.now() - 1000, toolCalls: 12, toolErrors: 0,
  });
  haloState.sessions.set('codex:fixture-1', mk('codex', 'codex:fixture-1', '夹具·Codex 构建任务（模拟）', 'tool', 'gpt-5.3-codex', 96000, 272000, 1234567, 45678, 890000, ['Bash', 'apply_patch']));
  haloState.sessions.set('zcode:fixture-1', mk('zcode', 'zcode:fixture-1', '夹具·ZCode 流式输出任务（模拟）', 'streaming', 'glm-4.7', 158000, 200000, 234567, 145678, 40000, ['mcp__node_repl__js']));
  haloState.sessions.set('workbuddy:fixture-1', mk('workbuddy', 'workbuddy:fixture-1', '夹具·WorkBuddy 思考任务（模拟）', 'thinking', 'step-r1', 32000, 128000, 89000, 12000, 20000, []));
  const tick = () => {
    const now = Date.now();
    const c = haloState.sessions.get('codex:fixture-1'), z = haloState.sessions.get('zcode:fixture-1');
    if (c) { c.tokens.output += 300 + Math.round(Math.random() * 500); c.lastActivity = now; }
    if (z) { z.tokens.output += 900 + Math.round(Math.random() * 1500); z.lastActivity = now; }
    const w = haloState.sessions.get('workbuddy:fixture-1'); if (w) { w.tokens.output += 100 + Math.round(Math.random() * 200); w.lastActivity = now; }
    if (c && Math.random() < 0.45) {
      c.currentTool = { name: Math.random() < 0.5 ? 'Bash' : 'apply_patch' };
      taskSceneState.bursts.push({ sessionId: c.key, source: 'codex', label: c.currentTool.name, failed: false, life: 0 });
      if (taskSceneState.bursts.length > 12) taskSceneState.bursts.shift();
    }
    haloApplySnapshot({ sessions: [...haloState.sessions.values()], totals: { running: 2 }, collector: { now: now } });
    syncTaskScene();
  };
  tick();
  setInterval(tick, 1600);
  haloStatus('live');
}
