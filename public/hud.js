/* Personal Halo 同心环 HUD：顶栏 KPI/来源定位/工具菜单、底部六块仪器、
 * 浮动执行遥测、纯光环模式、模型驱动强调色。数据来自 concentric.js 的
 * personal-halo 采集客户端（/state //events /health）。口径与 B 阶段一致：
 * 就绪≠在线、waiting=活动停顿、工具记录含未关联完成观察、tps 缺失不填数。 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const compact = n => n == null ? '—' : n >= 1e8 ? (n / 1e8).toFixed(2) + ' 亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + ' 万' : String(Math.round(n));
  const fmtT = ms => { if (!ms || ms <= 0) return '未知'; const d = new Date(ms); const t = new Date(); const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; return d.toDateString() === t.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`; };
  const hash = v => { let h = 2166136261; for (const c of String(v)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

  // ── 模型 → 强调色（规格映射；未知模型中性银灰，不猜品牌） ──
  const PALETTE = ['#e6a842', '#b7a7ed', '#f0a6c6', '#98e0cf', '#d6d18f', '#7fa8e8'];
  function modelColor(model) {
    const m = String(model ?? '').toLowerCase();
    if (!m || m === '未提供') return '#aeb4c2';
    if (/gpt|o\d|codex/.test(m)) return '#dfe6ee';
    if (/deepseek/.test(m)) return '#6ec8e8';
    if (/glm|chatglm/.test(m)) return '#7fe0c8';
    if (/claude/.test(m)) return '#e8c8a8';
    return PALETTE[hash(m) % PALETTE.length];
  }
  function hexLerp(a, b, k) {
    const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
    return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, '0')).join('');
  }
  let accentCur = '#aeb4c2', accentTgt = '#aeb4c2', accentAt = 0;
  function setAccent(color) {
    accentTgt = color; accentAt = performance.now();
    requestAnimationFrame(function lerp(now) {
      const k = Math.min(1, (now - accentAt) / 750);           // 规格：600–900ms 平滑过渡
      accentCur = hexLerp(accentCur, accentTgt, Math.min(1, k * 0.15 + 0.02));
      document.documentElement.style.setProperty('--accent', accentCur);
      document.documentElement.style.setProperty('--accent-soft', accentCur + '29');
      if (k < 1) requestAnimationFrame(lerp);
    });
  }

  // ── HUD 显隐偏好（本机） ──
  const hud = Object.assign({ top: true, panels: true, float: true, detail: true, pure: false },
    (() => { try { return JSON.parse(localStorage.getItem('personal-halo.hud.v1') || '{}'); } catch { return {}; } })());
  const saveHud = () => { try { localStorage.setItem('personal-halo.hud.v1', JSON.stringify(hud)); } catch {} };
  function applyHud() {
    document.body.classList.toggle('hud-top-hidden', !hud.top);
    document.body.classList.toggle('panels-collapsed', !hud.panels);
    document.body.classList.toggle('hud-float-hidden', !hud.float);
    document.body.classList.toggle('hud-detail-hidden', !hud.detail);
    document.body.classList.toggle('pure-halo', !!hud.pure);
    document.documentElement.style.setProperty('--panel-h', window.innerHeight <= 820 ? '132px' : '150px');
  }
  // 纯光环模式保留可找回的边缘入口
  const pureBtn = document.createElement('button');
  pureBtn.className = 'pure-recover';
  pureBtn.textContent = 'HUD';
  pureBtn.title = '恢复遥测面板（H）';
  pureBtn.style.cssText = 'position:fixed;top:6px;right:8px;z-index:40;font-size:10px;padding:2px 8px;opacity:.55';
  pureBtn.addEventListener('click', () => { hud.pure = false; saveHud(); applyHud(); });
  document.body.appendChild(pureBtn);

  // ── 顶栏来源环芯片：名称=聚焦，×=隐藏（可见减环入口）；＋环菜单列出可恢复来源 ──
  const chips = {};
  const chipLabels = { codex: 'Codex', dsh: 'DeepSeek', zcode: 'ZCode', workbuddy: 'WorkBuddy' };
  function saveRingPref() { try { localStorage.setItem('halo.rings.v1', JSON.stringify([...window.haloVisibleAgents])); } catch {} }
  function applyRingChange() {
    rebuildRings(); resizeAll(); saveRingPref();
    if (typeof buildShots === 'function') { buildShots.soft = true; buildShots(); agtWakeRender(); }
    syncChips(); syncFollowUi(); updateAddMenu();
  }
  const rc = $('ringChips');
  for (const a of ['codex', 'dsh', 'zcode', 'workbuddy']) {
    const chip = document.createElement('span'); chip.className = 'chip';
    const b = document.createElement('button');
    b.textContent = chipLabels[a];
    b.title = '聚焦该来源环';
    b.addEventListener('click', () => {
      const idx = ringByAgent[a];
      if (idx !== undefined) {
        haloFocusRing = idx;
        window.haloAutoFollow = false;                    // 手动聚焦：暂停自动抢焦
        window.haloFollowAgent = a; window.haloFollowKey = null;
        if (typeof buildShots === 'function') { buildShots.soft = true; buildShots(); agtWakeRender(); }
        setAccentFromAgent(a);
      } else {
        window.haloVisibleAgents.add(a);
        applyRingChange();
        return;
      }
      syncChips(); syncFollowUi();
    });
    const xb = document.createElement('button');
    xb.textContent = '×'; xb.className = 'chip-x';
    xb.title = '隐藏' + chipLabels[a] + '环（不停采集、不停止 Agent）';
    xb.setAttribute('aria-label', '隐藏' + chipLabels[a] + '环');
    xb.addEventListener('click', e => {
      e.stopPropagation();
      if (ringByAgent[a] !== undefined) { window.haloVisibleAgents.delete(a); applyRingChange(); }
    });
    chip.append(b, xb);
    chips[a] = { chip, name: b, x: xb };
    rc.appendChild(chip);
  }
  // ＋环：下拉菜单（键盘可操作：按钮原生焦点 + Escape 关闭）
  const addBtn = document.createElement('button');
  addBtn.textContent = '＋ 环'; addBtn.id = 'addRingBtn';
  addBtn.title = '添加隐藏的来源环';
  addBtn.setAttribute('aria-haspopup', 'true'); addBtn.setAttribute('aria-expanded', 'false');
  const addMenu = document.createElement('span'); addMenu.id = 'addRingMenu'; addMenu.className = 'hidden'; addMenu.setAttribute('role', 'menu');
  function updateAddMenu() {
    addMenu.innerHTML = '';
    for (const a of ['codex', 'dsh', 'zcode', 'workbuddy']) {
      if (ringByAgent[a] !== undefined) continue;
      const it = document.createElement('button');
      it.textContent = '＋ ' + chipLabels[a]; it.setAttribute('role', 'menuitem');
      it.addEventListener('click', () => {
        window.haloVisibleAgents.add(a);
        addMenu.classList.add('hidden'); addBtn.setAttribute('aria-expanded', 'false');
        applyRingChange();
      });
      addMenu.appendChild(it);
    }
    if (!addMenu.children.length) {
      const none = document.createElement('span'); none.className = 'menu-empty'; none.textContent = '全部来源已显示';
      addMenu.appendChild(none);
    }
  }
  addBtn.addEventListener('click', () => {
    const open = addMenu.classList.toggle('hidden');
    addBtn.setAttribute('aria-expanded', String(!open));
    if (!open) updateAddMenu();
  });
  addBtn.addEventListener('keydown', e => { if (e.key === 'Escape') { addMenu.classList.add('hidden'); addBtn.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('click', e => {
    if (!addMenu.contains(e.target) && e.target !== addBtn) { addMenu.classList.add('hidden'); addBtn.setAttribute('aria-expanded', 'false'); }
  });
  rc.append(addBtn, addMenu);
  function syncChips() {
    for (const a of Object.keys(chips)) {
      const on = ringByAgent[a] !== undefined;
      chips[a].name.classList.toggle('on', on);
      chips[a].name.classList.toggle('dim', !on);
      chips[a].x.classList.toggle('hidden', !on);   // 未显示的环没有 × 可减，由 ＋环 菜单恢复
      chips[a].chip.classList.toggle('off', !on);
    }
  }
  function syncFollowUi() {
    const ob = $('overviewButton');
    if (!ob) return;
    const paused = window.haloAutoFollow === false;
    ob.classList.toggle('paused', paused);
    ob.title = paused ? '自动跟随已暂停 — 点击恢复并回总览' : '返回四环总览（恢复自动跟随）';
  }
  syncFollowUi();

  // ── 顶栏菜单：操作统一收纳（环管理 / 任务编队 / 调参 / 设置 / 暂停 / HUD / 全屏）──
  const menu = $('toolsMenu'), menuBtn = $('menuToggle');
  function expandMenu(open) {
    if (!menu || !menuBtn) return;
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    if (open) { buildRingManager(); refreshSources(); }
  }
  // 数据源检测器：分来源列出监控文件/会话数/状态（元数据，不含会话内容）
  function refreshSources() {
    const box = document.getElementById('sourcesList');
    if (!box) return;
    fetch('/health').then(r => r.json()).then(h => {
      box.innerHTML = (h.sources || []).map(x => {
        const files = (x.files || []).map(f => f.replace(/\\/g, '/').split('/').slice(-2).join('/'));
        return `<div class="src-row"><b>${haloAgentLabel[x.id] ?? x.id}</b>
          <span class="src-st ${x.status === 'ok' ? 'ok' : 'bad'}">${x.status}</span>
          <span class="src-n">${x.sessions} 会话 · 监控 ${x.watching} 文件</span>
          <div class="src-files">${files.length ? files.join('<br>') : '未发现数据文件'}</div></div>`;
      }).join('');
    }).catch(() => { box.textContent = '读取失败（服务未响应）'; });
  }
  if (menuBtn) {
    menuBtn.addEventListener('click', () => expandMenu(menu.hidden));
    menuBtn.addEventListener('keydown', e => { if (e.key === 'Escape') expandMenu(false); });
    document.addEventListener('click', e => { if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== menuBtn) expandMenu(false); });
  }
  // 环管理（复用芯片：名称聚焦 / × 隐藏 / ＋环 菜单）
  function buildRingManager() {
    const host = $('ringManager');
    if (!host) return;
    const rcOld = $('ringChips');
    if (rcOld && rcOld.parentElement !== host) host.appendChild(rcOld);   // 不清空容器（会连芯片一起销毁）
    const menuOld = $('addRingMenu');
    if (menuOld && rcOld && menuOld.parentElement !== rcOld) rcOld.appendChild(menuOld);
    if (typeof updateAddMenu === 'function') updateAddMenu();
  }
  // 菜单动作
  const $id = id => document.getElementById(id);
  // 总览/暂停/调参/HUD 按钮已直接以原 id 放入菜单，由各自既有处理器驱动；这里仅保证点后收起
  for (const bid of ['overviewButton', 'motionButton', 'hudButton']) {
    $id(bid)?.addEventListener('click', () => expandMenu(false));
  }
  document.querySelector('.console')?.addEventListener('click', () => expandMenu(false));
  $id('menuFS')?.addEventListener('click', () => {
    expandMenu(false);
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  $id('menuPresetAgt')?.addEventListener('click', () => { if (typeof window.haloPreset === 'function' && window.haloPreset('agt')) { expandMenu(false); } });
  $id('menuPresetSmooth')?.addEventListener('click', () => { if (typeof window.haloPreset === 'function' && window.haloPreset('smooth')) { expandMenu(false); } });
  // 帧耗时读数（实测，不预承诺）
  setInterval(() => {
    const el = $id('perfLine'); if (!el) return;
    const P = window.haloPerf;
    if (!P || P.iv.length < 30) { el.textContent = '实测帧率：采样中…'; return; }
    const q = (arr, qn) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * qn))] ?? 0; };
    const fps = 1000 / Math.max(0.01, q(P.iv, 0.5));
    el.textContent = `实测帧率 P50 ${fps.toFixed(0)}/目标${agtQuality.fps} · 帧耗时 P95 ${q(P.wk, 0.95).toFixed(1)}ms`;
    // 分来源速率：检查点均速 / 实时 tps，各来源独立可辨；无样本标「—」
    const rl = document.getElementById('rateLine');
    if (rl) {
      const parts = [...haloState.sessions.values()].filter(s => (s.rate?.tps > 0) || (typeof s.tps === 'number' && s.tps > 0)).map(s => {
        const v = (typeof s.tps === 'number' && s.tps > 0) ? s.tps.toFixed(1) + ' 实时' : s.rate.tps.toFixed(1) + ' ≈';
        const age = s.rate ? (Date.now() - s.rate.at) / 60000 : 0;
        return `${haloAgentLabel[s.agent] ?? s.agent} ${v}${s.rate && age > 10 ? '(过期)' : ''}`;
      });
      rl.textContent = '来源速率：' + (parts.length ? parts.join(' · ') : '尚无检查点样本（需要来源完成至少两次用量检查点）');
    }
  }, 1000);
  // 粒子三模式：在个人启动链显式绑定（不依赖旧 agtBoot DOM）
  if (typeof bindFlowControls === 'function') { try { bindFlowControls(); } catch {} }
  // 双击环检查模式
  if (typeof bindHaloInspect === 'function') { try { bindHaloInspect(); } catch {} }
  // Wallpaper 模式（?wallpaper=1）：作为 Wallpaper Engine 等 Web 壁纸的地址时自动进入
  // 纯光环 + 隐全部仪器 + 自动跟随 + 关闭交互提示；不装任何系统组件、不自启。
  if (new URLSearchParams(location.search).has('wallpaper')) {
    window.haloWallpaper = true;
    window.haloAutoFollow = true;
    window.haloCallouts = false;
    document.body.classList.add('wallpaper-mode');
    if (typeof window.haloPreset === 'function') { try { window.haloPreset('smooth'); } catch {} }
    saveHud?.();
  }
  bindTaskSceneInteraction();

  // ── URL ?rings=N 快速预设（1/2/4 圈预览入口） ──
  const rp = new URLSearchParams(location.search).get('rings');
  if (rp) {
    const n = Math.max(1, Math.min(4, parseInt(rp, 10) || 4));
    haloVisibleAgents = new Set(['codex', 'dsh', 'zcode', 'workbuddy'].slice(0, n));
  } else {
    try {
      const savedRings = JSON.parse(localStorage.getItem('halo.rings.v1') || 'null');
      if (Array.isArray(savedRings) && savedRings.length) {
        const ok = savedRings.filter(x => ['codex', 'dsh', 'zcode', 'workbuddy'].includes(x));
        if (ok.length) haloVisibleAgents = new Set(ok);
      }
    } catch {}
  }

  // ── 选中状态 ──
  let selectedKey = null;
  function selectedSession() {
    if (!selectedKey) return null;
    const shaped = haloSessionsOf(selectedKey.split(':')[0]).find(s => s.id === selectedKey);
    return shaped ?? null;
  }
  function setAccentFromAgent(agent) {
    const s = haloSessionsOf(agent)[0];
    setAccent(modelColor(s?.model));
  }
  window.haloOnSnapshot = () => {
    // 自动选中：有可用会话但未选中时，选最近的活跃会话
    if (!selectedKey) {
      const cands = [...haloState.sessions.values()]
        .filter(s => s.state !== 'idle' || Date.now() - (s.lastActivity ?? 0) < 30 * 60000)
        .sort((a, b) => (a.state === 'idle') - (b.state === 'idle') || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
      if (cands.length) { selectedKey = cands[0].key; window.haloSelectedKey = selectedKey; agtState.selected = selectedKey; }
    }
    renderKpis(); renderFloat(); renderPanels(); syncChips();
    const sel = selectedSession();
    if (sel) setAccent(modelColor(sel.model));
  };
  window.haloOnStatus = st => {
    if ($('menuConnState')) $('menuConnState').textContent = st === 'live' ? '已连接' : st === 'stale' ? '连接中断，重试中' : '连接中';
    const el = $('connection');
    el.classList.toggle('stale', st !== 'live');
    el.innerHTML = '<i></i>' + (st === 'live' ? '已连接' : st === 'stale' ? '数据已过期' : '连接中');
    $('staleBanner').classList.toggle('hidden', st === 'live');
  };
  window.haloOnHealth = h => {
    window.haloHealth = h;
    const box = $('routes');
    if (!box) return;
    box.innerHTML = '';
    for (const src of h.sources ?? []) {
      const line = document.createElement('div');
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = { codex: 'Codex', dsh: 'DeepSeek', zcode: 'ZCode', workbuddy: 'WorkBuddy' }[src.id] ?? src.id;
      const st = document.createElement('span');
      if (src.status === 'ok') st.className = src.sessions > 0 ? 'on' : 'off';
      else st.className = 'off';
      st.textContent = src.status === 'ok'
        ? (src.sessions > 0 ? `近期 ${src.sessions} 会话` : src.watching > 0 ? '监听中 · 无近期记录' : '无近期记录')
        : src.status === 'error' ? '读取错误' : '未发现';
      line.append(nm, st);
      box.appendChild(line);
    }
  };
  window.haloOnPulse = d => {
    const feed = $('feed');
    for (const p of d.pulses ?? []) {
      const s = haloState.sessions.get(p.key);
      const div = document.createElement('div');
      const time = document.createElement('span'); time.className = 'time'; time.textContent = fmtT(Date.now());
      const ag = document.createElement('span'); ag.className = 'ag'; ag.textContent = (s?.agent ?? p.key ?? '').split(':')[0];
      const tx = document.createElement('span'); tx.className = 'tx';
      tx.textContent = ({ turn_start: '开始一轮', turn_end: '一轮结束', tool_start: '工具开始', tool_end: '工具完成', tool_error: '工具失败', task_done: '步骤完成', compact: '压缩', message: '输出' })[p.kind] ?? p.kind;
      div.append(time, ag, tx);
      if (String(p.callId ?? '').startsWith('item:')) {
        const u = document.createElement('span'); u.className = 'unlinked'; u.textContent = '未关联';
        div.appendChild(u);
      }
      feed.prepend(div);
      while (feed.children.length > 8) feed.lastChild.remove();
    }
  };

  function renderKpis() {
    const sources = new Set();
    let running = 0, records = 0, out = 0;
    for (const s of haloState.sessions.values()) {
      if (s.state !== 'idle') sources.add(s.agent);
      else if (Date.now() - (s.lastActivity ?? 0) < 30 * 60000) sources.add(s.agent);
      if (s.state === 'thinking' || s.state === 'streaming' || s.state === 'tool') running++;
      records += s.toolCalls ?? 0;
      out += s.tokens?.output ?? 0;
    }
    $('k0').textContent = String(sources.size);
    $('k1').textContent = String(running);
    $('k2').textContent = String(haloState.sessions.size);
    $('k3').textContent = compact(out);
    // 空态：仅当所有来源都被隐藏时才显示
    const en = $('emptyNote');
    if (en) en.classList.toggle('hidden', window.haloVisibleAgents.size > 0);
  }

  const STATE_TEXT = { thinking: '思考中', streaming: '输出中', tool: '工具运行', waiting: '活动停顿，待确认', error: '出错', idle: '空闲' };
  function renderList() { /* 会话列表由环带数据卡承担；左栏按规格已退出默认构图 */ }

  function renderFloat() {
    const s = selectedSession();
    $('fsModel').textContent = s ? (s.model ?? '—') : '—';
    $('fsTitle').textContent = s ? s.title : '等待本机会话';
    $('fsOut').textContent = s ? '输出 ' + compact(s.outputTokens) : '';
    $('fsSub').textContent = s ? `${{ codex: 'Codex', dsh: 'DeepSeek', zcode: 'ZCode', workbuddy: 'WorkBuddy' }[s.source] ?? s.source} · ${STATE_TEXT[s.state] ?? s.status} · ${fmtT((s.lastAt ?? 0) * 1000)}` : '';
  }

  // ── C: 实时监管——按来源（Agent）分席位，最多两路；代表会话稳定，不随快照抢排 ──
  const supervise = { locked: null, seats: [], sig: '' };
  function repOf(agent) {
    const mine = [...haloState.sessions.values()].filter(s => s.agent === agent);
    return mine.filter(x => x.state === 'thinking' || x.state === 'streaming' || x.state === 'tool').sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0]
      || mine.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0] || null;
  }
  // 供镜头轮换同步选中（浮条/上下文仪器与监管同源）
  window.haloSelectSession = function (agent, key) {
    const s = (key && haloState.sessions.get(key)) || repOf(agent);
    if (!s) return;
    selectedKey = s.key; window.haloSelectedKey = selectedKey; agtState.selected = selectedKey;
    renderFloat(); renderPanels();
    if (typeof agtMarkPanelsDirty === 'function') agtMarkPanelsDirty();   // 上下文仪器跟随选中
  };
  function renderSupervise() {
    const box = $('supervise'), autoBtn = $('superviseAuto');
    if (!box) return;
    const list = [...haloState.sessions.values()];
    const isRun = x => x.state === 'thinking' || x.state === 'streaming' || x.state === 'tool';
    // 席位：仍运行的来源保留席位；空位让给未入座的运行来源（按会话表稳定序，不按 lastActivity 抢排）
    const runningAgents = [...new Set(list.filter(isRun).map(x => x.agent))];
    let agents = supervise.seats.filter(a => runningAgents.includes(a));
    for (const a of runningAgents) if (!agents.includes(a) && agents.length < 2) agents.push(a);
    if (supervise.locked) {
      const la = supervise.locked.slice(0, supervise.locked.indexOf(':'));
      agents = [la, ...agents.filter(a => a !== la)].slice(0, 2);   // 手动锁定一路，另一路来自不同来源
    }
    supervise.seats = agents.slice();
    let chans = agents.map(a => ({ agent: a, s: repOf(a) })).filter(c => c.s);
    if (!chans.length) {
      const recent = list.slice().sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0];
      if (recent) chans = [{ agent: recent.agent, s: recent }];
    }
    const shown = chans.map(c => c.agent);
    const extra = runningAgents.filter(a => !shown.includes(a)).length;
    const rate = haloRatePresentation(list);
    const spd = $('speedVal');
    if (spd) { spd.textContent = rate.text; spd.className = rate.className || (rate.live ? 'live' : 'wait'); spd.title = rate.hint; }
    const sig = JSON.stringify([supervise.locked, extra, chans.map(c => [c.s.key, c.s.state, c.s.currentTool?.name ?? null, c.s.tokens ?? null, c.s.context ?? null, c.s.tps])]);
    if (sig === supervise.sig) return;
    supervise.sig = sig;
    document.body.classList.toggle('dual-supervise', chans.length === 2);   // 双路加宽面板
    window.haloSupervision = chans.map(c => ({ agent: c.agent, session: c.s }));   // 执行引线浮标同源
    if (autoBtn) autoBtn.classList.toggle('hidden', !supervise.locked);
    // 速度指标（顶栏）：只有真实流式 tps 才称实时，缺样本如实等待
    const ACOL = { codex: '#dfe6ee', dsh: '#6ec8e8', zcode: '#e6a842', workbuddy: '#98e0cf' };
    const fmt = n => (typeof n === 'number' ? compact(n) : '未提供');
    box.innerHTML = chans.map(c => {
      const x = c.s, tk = x.tokens, cx = x.context;
      const ctxPct = cx && cx.window ? Math.min(100, Math.round((cx.used ?? 0) / cx.window * 100)) : null;
      const ctxCls = ctxPct != null && ctxPct > 80 ? 'hot' : '';
      const stTxt = STATE_TEXT[x.state] ?? x.state;
      const tag = supervise.locked && c.agent === supervise.locked.slice(0, supervise.locked.indexOf(':')) ? '手动'
        : isRun(x) ? '自动' : (STATE_TEXT[x.state] ?? x.state);   // 空闲回退保留真实状态，不冒充空闲
      const tool = x.currentTool?.name;
      return `<div class="ctask" style="border-left-color:${ACOL[c.agent] || '#2a2f3a'}">
        <div class="ct-title" style="color:${ACOL[c.agent] || '#eef0f6'}" title="${esc(x.title || '')}">${esc(x.title || '(无标题)')}</div>
        <div class="ct-row"><span>状态</span><b class="${isRun(x) ? 'st-run' : ''}">${stTxt}<i class="sup-tag${tag === '手动' ? ' manual' : ''}">${tag}</i></b></div>
        <div class="ct-row"><span>模型</span><b>${esc(x.model || '未提供')}</b></div>
        <div class="ct-row"><span>${isRun(x) ? '当前工具' : '最近工具'}</span><b>${tool ? esc(tool) : '暂无记录'}</b></div>
        <div class="ct-row"><span>上下文</span><b class="${ctxCls}">${ctxPct == null ? '未提供' : ctxPct + '%'}</b></div>
        <div class="ct-bar">${ctxPct == null ? '' : `<i style="width:${ctxPct}%"></i>`}</div>
        <div class="ct-nums"><span>入 <i class="m">${fmt(tk && tk.input)}</i></span><span>出 <i class="p">${fmt(tk && tk.output)}</i></span><span>缓 <i class="l">${fmt(tk && tk.cacheRead)}</i></span></div>
      </div>`;
    }).join('') + (extra ? `<div class="sup-more">另有 ${extra} 路运行未展示 · 打开菜单→任务编队查看或替换</div>` : '');
  }
  $('superviseAuto')?.addEventListener('click', () => { supervise.locked = null; supervise.sig = ''; renderSupervise(); });

  function renderPanels() {
    // C: 底栏双路监管（签名门控，SSE 驱动更新，不随 500ms 轮询重排）
    renderSupervise();
    syncChips();   // 启动后首帧即同步芯片显隐态（此前仅交互时同步）
    // 主任务列表（新面板：编号 + 标题 + 状态）
    const list = [...haloState.sessions.values()]
      .filter(x => x.state !== 'idle' || Date.now() - (x.lastActivity ?? 0) < 30 * 60000)
      .sort((a, b) => (a.state === 'idle') - (b.state === 'idle') || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
    const al = $('agentsList');
    if (al) {
      al.innerHTML = list.length ? list.map((x, i) => {
        const sel = selectedKey === x.key;
        return `<div class="ag-row${x.state !== 'idle' ? ' running' : ''}" data-key="${esc(x.key)}" style="cursor:pointer${sel ? ';border-left:2px solid var(--accent);padding-left:4px' : ''}">`
          + `<span class="id">${String(i + 1).padStart(2, '0')}</span>`
          + `<span class="nm" title="${esc(x.title)}">${esc(x.title || x.key.slice(-8))}</span>`
          + `<span class="st">${STATE_TEXT[x.state] ?? x.status}</span></div>`;
      }).join('') : '<div style="color:#6a7182;font-size:11px;padding:8px 0">暂无近期会话</div>';
    }
    // 详情浮层（含计划步骤——按需展开）
    const s = selectedSession();
    const df = $('detailFloat');
    df.classList.toggle('hidden', !s || !hud.detail);
    if (s) {
      const tk = s.tasks;
      let planHtml = '';
      if (tk && tk.items?.length) {
        planHtml = '<div class="dt-row"><span>计划</span><span>'
          + tk.items.slice(0, 6).map(it => `${it.status === 'done' ? '✓' : it.status === 'active' ? '▸' : '·'} ${esc(it.text)}`).join(' | ')
          + `</span></div>`;
      }
      df.innerHTML = `<div class="dt-title">${esc(s.title)}</div>`
        + [['来源', { codex: 'Codex', dsh: 'DeepSeek', zcode: 'ZCode', workbuddy: 'WorkBuddy' }[s.source] ?? s.source],
           ['状态', STATE_TEXT[s.state] ?? s.status], ['模型', s.model || '未提供'],
           ['输入', compact(s.inputTokens)], ['输出', compact(s.outputTokens)], ['缓存', compact(s.cachedTokens)],
           ['上下文', s.contextWindow ? (Math.min(1, s.contextTokens / s.contextWindow) * 100).toFixed(1) + '%' : '未提供'],
           ['工具记录', `${s.toolCalls ?? 0} 条（含未关联完成观察）`],
           ...planHtml ? [null] : []].filter(Boolean).map(r => `<div class="dt-row"><span>${esc(r[0])}</span><span>${esc(r[1])}</span></div>`).join('')
        + planHtml;
    }
  }

  // ── 环带卡片点击 → 选择会话（同步浮条/底栏/详情） ──
  document.getElementById('stage').addEventListener('click', e => {
    const r = e.target.getBoundingClientRect();
    const hit = window.haloHitTest && window.haloHitTest(e.clientX - r.left, e.clientY - r.top);
    if (hit?.session) {
      selectedKey = hit.session.id; window.haloSelectedKey = selectedKey; agtState.selected = selectedKey;
      window.haloAutoFollow = false; window.haloFollowAgent = hit.session.source; window.haloFollowKey = hit.session.id;
      setAccent(modelColor(hit.session.model)); renderFloat(); renderPanels();
      if (typeof agtMarkPanelsDirty === 'function') agtMarkPanelsDirty();
      if (typeof buildShots === 'function') { buildShots.soft = true; buildShots(); agtWakeRender(); }
      syncFollowUi();
    }
  });
  // 主任务列表点击
  document.getElementById('agentsList')?.addEventListener('click', e => {
    const row = e.target.closest('[data-key]');
    if (row) {
      selectedKey = row.dataset.key; window.haloSelectedKey = selectedKey; agtState.selected = selectedKey;
      window.haloAutoFollow = false;
      window.haloFollowAgent = selectedKey.slice(0, selectedKey.indexOf(':'));
      window.haloFollowKey = selectedKey;
      supervise.locked = selectedKey; supervise.sig = '';   // 手动锁定该监管通道（恢复自动按钮可解）
      renderFloat(); renderPanels();
      if (typeof agtMarkPanelsDirty === 'function') agtMarkPanelsDirty();
      if (typeof buildShots === 'function') { buildShots.soft = true; buildShots(); agtWakeRender(); }
      syncFollowUi();
    }
  });

  // ── 工具按钮 ──
  $('overviewButton').addEventListener('click', () => {
    window.haloAutoFollow = true; window.haloFollowAgent = null; window.haloFollowKey = null;
    haloFocusRing = 0;
    if (typeof buildShots === 'function') { buildShots.soft = true; buildShots(); agtWakeRender(); }
    syncFollowUi();
  });
  $('motionButton').addEventListener('click', () => {
    agtState.paused = !agtState.paused;
    $('motionButton').setAttribute('aria-pressed', String(agtState.paused));
    $('motionButton').textContent = agtState.paused ? '继续' : '暂停';
    if (!agtState.paused) agtWakeRender();
  });
  let hudHidden = false;
  $('hudButton').addEventListener('click', () => {
    hudHidden = !hudHidden;
    hud.pure = hudHidden; saveHud(); applyHud();
    $('hudButton').textContent = hudHidden ? '恢复 HUD' : 'HUD';
    $('pureHint').classList.toggle('hidden', !hudHidden);
  });
  $('togglePanels').addEventListener('click', () => {
    hud.panels = !hud.panels; agtSettings.panelsCollapsed = !hud.panels;
    saveHud(); saveScreenSettings(); applyHud();
    $('togglePanels').textContent = hud.panels ? '收起仪器栏 ▾' : '展开仪器栏 ▴';
    $('togglePanels').setAttribute('aria-expanded', String(hud.panels));
    window.__haloBottomInset = hud.panels ? (window.innerHeight <= 820 ? 132 : 150) + 24 : 22;
    requestAnimationFrame(() => { resizePanels(); agtMarkPanelsDirty(); agtWakeRender(); });
  });
  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]')) return;
    if (e.target.matches('input,textarea,select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'h' || e.key === 'H') $('hudButton').click();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { haloWake(); renderFloat(); renderPanels(); } });
  window.addEventListener('resize', () => { applyHud(); });

  window.haloHudSettings = {
    get: () => ({ panels: hud.panels }),
    apply: options => {
      hud.panels = options.panels;
      agtSettings.panelsCollapsed = !hud.panels;
      saveHud(); applyHud();
      $('togglePanels').textContent = hud.panels ? '收起仪器栏 ▾' : '展开仪器栏 ▴';
      $('togglePanels').setAttribute('aria-expanded', String(hud.panels));
      window.__haloBottomInset = hud.panels ? (window.innerHeight <= 820 ? 132 : 150) + 24 : 22;
      resizeAll();
    },
    select: (key, lock) => {
      const session = haloState.sessions.get(key);
      if (!session) return;
      if (lock) { supervise.locked = key; supervise.sig = ''; }
      window.haloSelectSession(session.agent, key);
      window.haloAutoFollow = false;
      window.haloFollowAgent = session.agent; window.haloFollowKey = key;
      buildShots.soft = true; buildShots(); agtWakeRender(); syncFollowUi();
    },
  };

  // ── 启动 ──
  applyHud();
  window.__haloBottomInset = 150 + 24;
  if (window.haloFixture) { haloFixtureBoot(); } else { haloConnect(); }   // 夹具页用模拟数据，不连 SSE
  renderPanels();
})();
