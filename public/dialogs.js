/* 任务编队与本机设置；复用采集快照、HUD 选择和引擎质量控制。 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const names = { codex: 'Codex', dsh: 'DeepSeek', zcode: 'ZCode', workbuddy: 'WorkBuddy' };
  const colors = { codex: '#dfe6ee', dsh: '#6ec8e8', zcode: '#e6a842', workbuddy: '#98e0cf' };
  const states = { thinking: '思考中', streaming: '输出中', tool: '工具运行', waiting: '活动停顿，待确认', idle: '空闲', error: '出错' };
  const running = s => ['thinking', 'streaming', 'tool'].includes(s.state);
  const number = n => typeof n === 'number' ? n.toLocaleString('zh-CN') : '未提供';
  const defaults = { name: 'Personal Halo', quality: 'balanced', quiet: false, callouts: true, autoFollow: true, panels: true };
  const actions = document.querySelector('#toolsMenu .tm-actions');
  actions.insertAdjacentHTML('afterbegin', '<button type="button" id="tasksButton" role="menuitem">任务编队</button><button type="button" id="personalSettingsButton" role="menuitem">设置</button>');
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="fleetDialog" class="halo-dialog fleet-dialog" aria-labelledby="fleetHeading">
      <div class="dialog-head"><h2 id="fleetHeading">任务编队</h2><button type="button" data-close aria-label="关闭任务编队">×</button></div>
      <div class="fleet-filters"><label>来源 <select id="fleetSource"><option value="all">全部来源</option>${Object.entries(names).map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label>
        <label><input type="checkbox" id="fleetRunning">仅执行中</label><label id="childFilterLabel"><input type="checkbox" id="fleetChildren" checked>显示协作子任务</label></div>
      <p id="fleetCount" class="dialog-muted"></p>
      <div id="fleetSources" class="source-summary"></div>
      <div id="fleetList" class="fleet-list" aria-label="任务列表"></div>
      <section id="fleetDetail" class="fleet-detail" aria-label="任务详情"></section>
      <div class="dialog-footer"><span id="fleetNotice" role="status"></span><button type="button" id="fleetLocate">定位环带</button><button type="button" id="fleetWatch" class="primary">监管此任务</button></div>
    </dialog>
    <dialog id="personalSettings" class="halo-dialog settings-dialog" aria-labelledby="settingsHeading">
      <form id="personalSettingsForm">
        <div class="dialog-head"><h2 id="settingsHeading">大屏设置</h2><button type="button" data-close aria-label="关闭设置">×</button></div>
        <label class="setting-name">大屏名称<input id="screenName" maxlength="40" autocomplete="off"></label>
        <fieldset><legend>画面质量</legend><div class="quality-options">${[['balanced','均衡'],['high','精细'],['low','流畅']].map(([v,n]) => `<label><input type="radio" name="quality" value="${v}"><span>${n}</span></label>`).join('')}</div><p id="settingsPerf" class="dialog-muted">性能采样中</p></fieldset>
        <label class="setting-row">安静模式（降低亮度）<input id="screenQuiet" type="checkbox"></label>
        <label class="setting-row">显示底部信息栏<input id="screenPanels" type="checkbox"></label>
        <label class="setting-row">执行引线浮标<input id="screenCallouts" type="checkbox"></label>
        <label class="setting-row">自动跟随运行环<input id="screenFollow" type="checkbox"></label>
        <p class="dialog-muted">质量调整效果密度与精度；安静模式保留运动，暂停请使用菜单。</p>
        <div class="dialog-footer"><button type="button" id="settingsReset">恢复默认</button><button type="button" data-close>取消</button><button type="submit" class="primary">保存设置</button></div>
        <p class="dialog-muted">恢复默认先填入表单，保存后生效。</p>
      </form>
    </dialog>`);
  let returnFocus = null, selected = null, listSignature = '', sourceSignature = '';
  const closeMenu = () => { $('toolsMenu').hidden = true; $('menuToggle').setAttribute('aria-expanded', 'false'); $('menuToggle').textContent = '菜单 ▾'; };
  function open(dialog) {
    returnFocus = $('menuToggle'); closeMenu(); dialog.showModal();
  }
  for (const dialog of [$('fleetDialog'), $('personalSettings')]) {
    dialog.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('close', () => returnFocus?.focus());
    dialog.addEventListener('click', e => { if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    }});
  }
  function renderFleet() {
    if (!$('fleetDialog').open) return;
    const all = [...haloState.sessions.values()];
    const hasChildren = all.some(s => s.parentKey);
    $('fleetChildren').disabled = !hasChildren;
    $('childFilterLabel').title = hasChildren ? '仅使用已记录的 parentKey 关系' : '当前没有已记录的父子任务关系';
    const list = all.filter(s => ($('fleetSource').value === 'all' || s.agent === $('fleetSource').value)
      && (!$('fleetRunning').checked || running(s)) && ($('fleetChildren').checked || !s.parentKey));
    $('fleetCount').textContent = `${list.length} 个会话 · ${list.filter(running).length} 个执行中 · ${all.filter(s => s.parentKey).length} 个已记录子任务${window.haloFixture ? ' · 模拟数据' : ''}`;
    const summary = Object.entries(names).map(([id, name]) => {
      const sessions = all.filter(s => s.agent === id), health = window.haloHealth?.sources?.find(s => s.id === id);
      const read = window.haloFixture ? '模拟采集' : !health ? '健康采样中' : health.status === 'ok' ? '读取正常' : health.status === 'error' ? '读取错误' : '未发现';
      return `<div><b style="color:${colors[id]}">${name}</b><span>${read}</span><span>${sessions.length} 会话 / ${sessions.filter(running).length} 执行</span></div>`;
    }).join('');
    if (summary !== sourceSignature) { $('fleetSources').innerHTML = summary; sourceSignature = summary; }
    if (!list.some(s => s.key === selected)) selected = list[0]?.key ?? null;
    const signature = JSON.stringify(list.map(s => [s.key, s.title, s.state, s.model, s.parentKey]));
    if (signature !== listSignature) {
      const focusedKey = document.activeElement?.closest('[data-session]')?.dataset.session;
      $('fleetList').innerHTML = list.length ? list.map(s => `<button type="button" class="fleet-card" data-session="${esc(s.key)}" style="--source:${colors[s.agent] || colors.codex}"><span class="fleet-meta">${esc(names[s.agent] || s.agent)} · ${s.parentKey ? '子任务' : '会话'} · ${esc(s.key.slice(-6))}<em>${esc(states[s.state] || s.state)}</em></span><strong>${esc(s.title || '未命名会话')}</strong><span class="dialog-muted">${esc(s.model || '模型未提供')}</span><span data-output></span></button>`).join('') : '<p class="dialog-muted">当前筛选下没有任务。</p>';
      listSignature = signature;
      if (focusedKey) [...$('fleetList').querySelectorAll('[data-session]')].find(b => b.dataset.session === focusedKey)?.focus({ preventScroll: true });
    }
    for (const button of $('fleetList').querySelectorAll('[data-session]')) {
      const s = haloState.sessions.get(button.dataset.session);
      button.setAttribute('aria-pressed', String(button.dataset.session === selected));
      button.querySelector('[data-output]').textContent = '累计输出 ' + number(s?.tokens?.output);
    }
    const s = haloState.sessions.get(selected);
    $('fleetLocate').disabled = $('fleetWatch').disabled = !s;
    if (!s) { $('fleetDetail').textContent = '选择任务查看详情。'; return; }
    const ctx = s.context?.window && typeof s.context.used === 'number' ? `${(100*s.context.used/s.context.window).toFixed(1)}% · ${number(s.context.used)} / ${number(s.context.window)}` : '未提供';
    const rows = [['来源', names[s.agent]], ['状态', states[s.state] || s.state], ['模型', s.model || '未提供'], ['输入', number(s.tokens?.input)], ['输出', number(s.tokens?.output)], ['缓存读取', number(s.tokens?.cacheRead)], ['上下文', ctx], ['当前工具', s.currentTool?.name || '暂无记录'], ['项目 / 工作目录', s.project || '未提供'], ['父任务', s.parentKey || '未记录'], ['完整 ID', s.key]];
    const detail = `<h3>${esc(s.title || '未命名会话')}</h3><dl>${rows.map(([k,v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl><p class="dialog-muted">来源字段口径：${s.agent === 'zcode' ? 'model_usage 用量' : s.agent === 'codex' ? '采集器已归一化用量；双通道不相加' : '采集器来源记录'}。工具记录含未关联完成观察，未知关系不推断。</p>`;
    if ($('fleetDetail').innerHTML !== detail) $('fleetDetail').innerHTML = detail;
    $('fleetLocate').textContent = window.haloVisibleAgents.has(s.agent) ? '定位环带' : '恢复环并定位';
  }
  $('tasksButton').addEventListener('click', () => { listSignature = ''; sourceSignature = ''; selected = window.haloSelectedKey; open($('fleetDialog')); renderFleet(); });
  for (const id of ['fleetSource','fleetRunning','fleetChildren']) $(id).addEventListener('change', () => { $('fleetNotice').textContent = ''; renderFleet(); });
  $('fleetList').addEventListener('click', e => { const b = e.target.closest('[data-session]'); if (b) { selected = b.dataset.session; renderFleet(); } });
  function locate(lock) {
    const s = haloState.sessions.get(selected); if (!s) return;
    if (!window.haloVisibleAgents.has(s.agent)) {
      window.haloVisibleAgents.add(s.agent); rebuildRings(); resizeAll(); syncTaskScene();
      try { localStorage.setItem('halo.rings.v1', JSON.stringify([...window.haloVisibleAgents])); } catch {}
    }
    window.haloHudSettings.select(s.key, lock); $('fleetDialog').close();
  }
  $('fleetLocate').addEventListener('click', () => locate(false));
  $('fleetWatch').addEventListener('click', () => locate(true));
  setInterval(renderFleet, 600);

  function current() { return { ...defaults, ...agtSettings, panels: window.haloHudSettings.get().panels, callouts: window.haloCallouts !== false, autoFollow: window.haloAutoFollow !== false }; }
  function fill(s) {
    $('screenName').value = s.name;
    document.querySelector(`#personalSettings input[name="quality"][value="${['balanced','high','low'].includes(s.quality) ? s.quality : 'balanced'}"]`).checked = true;
    for (const [id,key] of [['screenQuiet','quiet'],['screenPanels','panels'],['screenCallouts','callouts'],['screenFollow','autoFollow']]) $(id).checked = s[key];
  }
  function apply(s, persist) {
    if (window.haloWallpaper) {   // 壁纸模式：设置回放不覆盖壁纸语义（纯画面/自动跟随/无浮标/轻画质）
      s = { ...s, callouts: false, autoFollow: true, quality: 'low' };
    }
    Object.assign(agtSettings, { name: s.name, quality: s.quality, quiet: s.quiet, callouts: s.callouts, autoFollow: s.autoFollow });
    document.querySelector('.brand').textContent = s.name;
    document.title = (window.haloFixture ? '【夹具】' : '') + s.name;
    document.body.classList.toggle('halo-quiet', s.quiet);
    window.haloCallouts = s.callouts;
    if (!s.callouts) document.querySelectorAll('.halo-callout').forEach(el => el.classList.add('hidden'));
    window.haloAutoFollow = s.autoFollow;
    if (s.autoFollow) { window.haloFollowAgent = null; window.haloFollowKey = null; }
    $('overviewButton').classList.toggle('paused', !s.autoFollow);
    $('overviewButton').title = s.autoFollow ? '返回总览（恢复自动跟随）' : '自动跟随已暂停 — 点击恢复';
    window.agtSetQuality(s.quality);
    window.haloHudSettings.apply(s);
    if (persist) saveScreenSettings();
    agtWakeRender();
  }
  $('personalSettingsButton').addEventListener('click', () => { fill(current()); $('settingsPerf').textContent = $('perfLine').textContent; open($('personalSettings')); });
  $('settingsReset').addEventListener('click', () => fill(defaults));
  $('personalSettingsForm').addEventListener('submit', e => {
    e.preventDefault();
    apply({ name: $('screenName').value.trim() || defaults.name, quality: document.querySelector('#personalSettings input[name="quality"]:checked').value, quiet: $('screenQuiet').checked, panels: $('screenPanels').checked, callouts: $('screenCallouts').checked, autoFollow: $('screenFollow').checked }, true);
    $('personalSettings').close();
  });
  // Apply only the persisted personal settings, without invoking old AGT DOM bindings.
  apply({ ...current(), callouts: agtSettings.callouts !== false, autoFollow: agtSettings.autoFollow !== false }, false);
})();
