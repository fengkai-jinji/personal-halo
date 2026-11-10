window.__errs3 = window.__errs3 || [];
window.addEventListener('error', e => window.__errs3.push(e.message + ' @ L' + e.lineno));

/* personal-halo 同心多环场景引擎。
 * 引擎主体改造自 AGT 参考包 runtime.js（references/AGT前端参考包，manifest.json 校验），
 * AGT 基于 HALOFLUX（Copyright (c) 2026 Ryder191，PolyForm Noncommercial 1.0.0）。
 * 版权注释与许可证随附：personal-halo/LICENSE、NOTICE、references/AGT前端参考包/LICENSE、UPSTREAM.txt。
 * 按用户要求，前端画面不输出原作署名/来源链接；来源信息仅保留在本注释与随附许可文件。
 * 结构改造（2026-11-08，ZCode）：AGT 全局单环 → RingState 多环（withRing 上下文切换，
 * 相位/数据带/卡片缓存逐环隔离）；数据源替换为 personal-halo 采集器（/state //events /health）；
 * 锐利信息层逐环绘制；编织光场一份全幅共享。绘制动势保持 AGT 参考原样。 */
const TAU = Math.PI * 2, rnd = Math.random;
const rr = (a, b) => a + rnd() * (b - a);
const pick = a => a[(rnd() * a.length) | 0];
const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
let DPR = Math.min(window.devicePixelRatio || 1, 2);
const FONT = '"JetBrains Mono","Microsoft YaHei",Consolas,monospace';

function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * DPR)); c.height = Math.max(1, Math.ceil(h * DPR));
  c.x = c.getContext('2d'); c.x.setTransform(DPR, 0, 0, DPR, 0, 0);
  return c;
}
function fit(c) { if (!c || !c.getBoundingClientRect) return;
  const r=c.getBoundingClientRect(),d=agtUiPixelRatio();
  c.width=Math.max(1,Math.round(r.width*d));c.height=Math.max(1,Math.round(r.height*d));
  c.x=c.getContext('2d');c.x.setTransform(d,0,0,d,0,0);
  c.w=r.width;c.h=r.height;c.pixelRatio=d;return c;
}

/* =========================================================
   MAIN STAGE
   ========================================================= */
const stage = document.getElementById('stage'); let S = stage.getContext('2d'); const agtSharpContext=S; let S_MAIN=S;
let W, H, cx, cy, R, RO, RMAX, thV, thS;
let webBase, webLayers = [], layerEnv = [0, 0, 0], trailC, glowC, laneC;
let curves = [], runners = [], comets = [], cards = [], wedges = [], pulses = [];
let webRot = 0, ringRot = 0, ringVel = 0, OSTEP = 0.0038;
let GS = 3; // glow buffer downscale
let FS = 0.5; let farC; // far-layer buffer (depth of field)
const HAS_FILTER = 'filter' in S;
const easeIO = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeO = t => 1 - Math.pow(1 - t, 3);

/* ---------- live configuration (driven by the console) ---------- */
// [key, label, min, max, step, group, rebuild]
const PARAMS = [
  ['tempo', '整体节拍速度', 0.4, 2.5, 0.05, '全局'],
  ['camera', '自动运镜 (0关 1开)', 0, 1, 1, '全局'],
  ['camZoom', '运镜推近幅度', 0, 2, 0.05, '全局'],
  ['glow', '柔光层强度', 0, 1.5, 0.05, '全局'],
  ['scan', '扫描线 (0关 1开)', 0, 1, 1, '全局'],

  ['ringSpeed', '圆环转动幅度/速度', 0, 3, 0.05, '圆环'],
  ['ringPause', '圆环停顿时长', 0, 3, 0.05, '圆环'],
  ['ringWidth', '环带厚度', 0.6, 1.6, 0.02, '圆环', 'resize'],
  ['rimBright', '内外缘细线亮度', 0, 2, 0.05, '圆环'],
  ['rimWidth', '内外缘细线带宽度', 0.3, 2.5, 0.05, '圆环', 'slots'],
  ['dataFlicker', '数据块刷新/闪烁', 0, 4, 0.1, '圆环'],

  ['webBright', '底层网线亮度', 0.1, 3, 0.05, '圈内', 'web'],
  ['webPulseBase', '网线闪烁层基础亮度', 0, 1, 0.02, '圈内'],
  ['webPulseAmp', '网线闪烁层节拍亮度', 0, 1, 0.02, '圈内'],
  ['webSpin', '网线整体转速', 0, 5, 0.1, '圈内'],
  ['runnerCount', '单独亮线 数量', 0, 900, 1, '圈内'],
  ['runnerBright', '单独亮线 亮度', 0, 2, 0.05, '圈内'],
  ['runnerWidth', '单独亮线 粗细', 0.3, 3, 0.05, '圈内'],
  ['runnerSpeed', '单独亮线 速度', 0.1, 4, 0.05, '圈内'],
  ['runnerVariety', '单独亮线 速度差异', 0, 1, 0.05, '圈内'],
  ['cometPerBeat', '成组光束 每拍数量', 0, 6, 0.1, '圈内'],
  ['cometBurst', '成组光束 重拍爆发数', 0, 12, 0.5, '圈内'],
  ['cometTrickle', '成组光束 拍间零星(每秒)', 0, 6, 0.1, '圈内'],
  ['cometLines', '成组光束 每组线数', 0.3, 3, 0.05, '圈内'],
  ['cometWidth', '成组光束 宽度', 0.3, 3, 0.05, '圈内'],
  ['cometBright', '成组光束 亮度', 0.1, 2.5, 0.05, '圈内'],
  ['cometGlow', '成组光束 柔光', 0, 3, 0.05, '圈内'],
  ['cometSpeed', '成组光束 速度', 0.3, 3, 0.05, '圈内'],
  ['cometFollow', '成组光束 跟随圆环 (0/1)', 0, 1, 1, '圈内'],

  ['beamBright', '伸缩光束 亮度', 0, 2.5, 0.05, '环外'],
  ['beamLen', '伸缩光束 长度', 0.2, 1.8, 0.05, '环外'],
  ['beamWidth', '伸缩光束 线粗细', 0.3, 3, 0.05, '环外'],
  ['beamBounce', '回弹波浪层 强度', 0, 2, 0.05, '环外'],
  ['beamGlow', '伸缩光束 柔光', 0, 6, 0.1, '环外'],
  ['dashBright', '流动短线 亮度', 0, 2, 0.05, '环外'],
  ['hazeCount', '宽光带 数量', 0, 30, 1, '环外'],
  ['hazeBright', '宽光带 亮度', 0, 3, 0.05, '环外'],
  ['flyerCount', '飞出流线(单独) 数量', 0, 3, 0.05, '环外', 'flyers'],
  ['flyerBright', '飞出流线(单独) 亮度', 0, 3, 0.05, '环外'],
  ['flyerWidth', '飞出流线 粗细', 0.3, 3, 0.05, '环外'],
  ['flyerSpeed', '飞出流线 速度', 0.2, 3, 0.05, '环外'],
  ['burstRate', '飞出流线(成组) 频率', 0, 5, 0.1, '环外'],
  ['burstSize', '飞出流线(成组) 每组数量', 0.2, 3, 0.05, '环外'],
  ['burstBright', '飞出流线(成组) 亮度', 0, 2.5, 0.05, '环外'],
  ['flareRate', '根部闪光 频率', 0, 5, 0.1, '环外'],
  ['flareBright', '根部闪光 亮度', 0, 2, 0.05, '环外'],
  ['rimDensity', '内外缘细线 密度', 0.3, 3, 0.05, '圆环'],
  ['depthBlur', '远景虚化 (环外远层)', 0, 5, 0.1, '空间层次'],
  ['depthDim', '远景亮度', 0, 1.5, 0.05, '空间层次'],
  ['webBlur', '圈内底层虚化', 0, 4, 0.1, '空间层次', 'web'],
  ['parallax', '视差 (运镜时远近错位)', 0, 1.5, 0.05, '空间层次'],
  ['bokeh', '前景光斑 数量', 0, 80, 1, '空间层次'],
  ['bokehBright', '前景光斑 亮度', 0, 3, 0.05, '空间层次'],
  ['atmos', '空间雾气', 0, 3, 0.05, '空间层次'],
  ['ringShadow', '圆环遮挡阴影', 0, 2, 0.05, '空间层次'],
  ['vignette', '暗角', 0, 1.5, 0.05, '空间层次'],
];
const BASE = {
  tempo: 1, camera: 1, camZoom: 1, glow: 1, scan: 1,
  ringSpeed: 1, ringPause: 1, ringWidth: 1, rimBright: 1, rimWidth: 1, dataFlicker: 1,
  webBright: 1, webPulseBase: 0.15, webPulseAmp: 0.85, webSpin: 1,
  runnerCount: 336, runnerBright: 1, runnerWidth: 1, runnerSpeed: 1, runnerVariety: 1,
  cometPerBeat: 1.1, cometBurst: 4, cometTrickle: 0, cometLines: 1, cometWidth: 1, cometBright: 1, cometGlow: 1.1, cometSpeed: 1, cometFollow: 0,
  beamBright: 1, beamBounce: 1, beamLen: 1, beamWidth: 1, beamGlow: 1, dashBright: 1, hazeCount: 8, hazeBright: 1,
  flyerCount: 1, flyerBright: 1, flyerWidth: 1, flyerSpeed: 1, burstRate: 1, burstSize: 1, burstBright: 1, flareRate: 1, flareBright: 1,
  rimDensity: 1, depthBlur: 1.4, depthDim: 0.9, webBlur: 0.7, parallax: 0.6, bokeh: 16, bokehBright: 1, atmos: 1, ringShadow: 1, vignette: 0.7,
};
const PRESETS = {
  A: { ...BASE, webBright: 1.25, webPulseBase: 0.3, webPulseAmp: 0.4, runnerCount: 45, runnerVariety: 0,
       cometPerBeat: 2.5, cometBurst: 5, cometTrickle: 1.6, cometFollow: 1, cometGlow: 0.85 },
  B: { ...BASE },
};
// 你的默认效果：把控制台「导出」的 values 粘贴进来替换 null，发给任何电脑打开都会默认使用它
const BAKED_MINE = {tempo: 2.5, camera: 1, camZoom: 1, glow: 1.1, scan: 1, ringSpeed: 3, ringPause: 1.2, ringWidth: 1.3, rimBright: 1.8, rimWidth: 1.3, dataFlicker: 1, webBright: 0.9, webPulseBase: 0.1, webPulseAmp: 0.8, webSpin: 1, runnerCount: 788, runnerBright: 0.5, runnerWidth: 1, runnerSpeed: 0.6, runnerVariety: 0.4, cometPerBeat: 2.3, cometBurst: 9, cometTrickle: 1.5, cometLines: 1, cometWidth: 1, cometBright: 1, cometGlow: 1.1, cometSpeed: 0.8, cometFollow: 1, beamBright: 1.8, beamLen: 1.8, beamWidth: 0.7, beamBounce: 2, beamGlow: 3.5, dashBright: 1.9, hazeCount: 22, hazeBright: 1.5, flyerCount: 3, flyerBright: 3, flyerWidth: 1.4, flyerSpeed: 2.2, burstRate: 3.5, burstSize: 3, burstBright: 2.5, flareRate: 3.5, flareBright: 2, rimDensity: 1.2, depthBlur: 0, depthDim: 0.1, webBlur: 0, parallax: 0, bokeh: 0, bokehBright: 0, atmos: 0, ringShadow: 0, vignette: 0};   // 2026-10-21 定稿默认
if (BAKED_MINE) PRESETS.MINE = { ...BASE, ...BAKED_MINE };
const C = { ...(PRESETS.MINE || PRESETS.B) };
const zf = z => 1 + (z - 1) * C.camZoom;

const TOK = ['load_collection()', 'extract_eq', '∂u/∂t', 'rho', 'grad(p)', 'dt=1e-3', 'assert', 'residual', 'solve()',
  'mesh', 'bc.apply', 'flux', 'CFL', '0.0041', 'ok', 'PASS', 'ref#12', 'scene_07', 'u_star', 'div(u)', 'proj', 'advect',
  'step++', 'tol', '1.2e-6', 'kernel', 'paper[37]', 'eq.(4)', 'fig.3', 'table2', 'nu=0.01', 'v_x', 'omega', 'bounce',
  'f_eq', 'stream', 'collide', 'Re=100', 'check', '>>>', 'match', 'diff', 'L2', 'grid64', 'cfg', 'seed=7'];

/* ---------- rhythm: an uneven beat clock drives everything ---------- */
const PATTERN = [0.5, 0.25, 0.25, 0.5, 0.5, 0.75, 0.25, 0.25, 0.25, 1.0];
let beatT = 0.4, beatI = 0, sinceBeat = 9, beatN = 0, env = 0;
function updateBeat(dt) {
  beatT -= dt; sinceBeat += dt;
  if (beatT <= 0) { beatT += PATTERN[beatI++ % PATTERN.length] * 0.92 / C.tempo; sinceBeat = 0; beatN++; onBeat(); }
  env = Math.exp(-sinceBeat * 4.5);
}
function onBeat() {
  // ring: kick every other beat → stepped, fast rotation（逐环独立相位，错峰触发）
  // 每拍至多一环起转（按 ring 序轮转）：多环同拍齐动会在视觉上「撞在一起」、随后同时进 hold「一起卡住」。
  // 轮转制保留 AGT 式步进节奏，同时保证任意时刻至多一环在动。
  if (RINGS.length && !RINGS.some(r => r.rot.t < r.rot.dur)) {   // 全局动画忙检查：跨拍不重叠，严格至多一环在动
    const kickIdx = beatN % RINGS.length;
    withRingEach((st, i) => { if (i === kickIdx && rot.t >= rot.dur && rot.hold <= 0) ringMove(); });
  }
  // comets come in bursts
  const n = Math.round((beatN % 4 === 0 ? C.cometBurst : C.cometPerBeat) * rr(0.6, 1.4));
  for (let i = 0; i < n; i++) setTimeout(() => spawnComet(), i * rr(30, 90));
  // E: 运行中的可见环产生身份色彗星（错峰、少量、各自飞向自己的数据卡）
  for (const st of RINGS) {
    if (st.intensity <= 0.3) continue;
    if ((beatN + (st.phaseOff || 0)) % 2 === 0 && rnd() < 0.7) {
      const alive = comets.filter(c => c.agent === st.id).length;
      if (alive < 2) setTimeout(() => spawnAgentComet(st.id), rr(100, 650));
    }
  }
  // web layers shimmer
  layerEnv[(rnd() * 3) | 0] = 1;
  if (beatN % 4 === 0) layerEnv = layerEnv.map(() => rr(0.6, 1));
  // outer: travelling wave + random wedge hits
  const dir = rnd() < 0.5 ? 1 : -1, big = beatN % 8 === 0;
  pulses.push({ c: dir > 0 ? -thS - 0.15 : thS + 0.15, v: dir * rr(0.7, 1.6) * (big ? 0.7 : 1), w: big ? rr(0.25, 0.4) : rr(0.05, 0.16), amp: big ? 1 : rr(0.45, 0.9), life: rr(1.2, 2.0), L: 0 });
  pulses.forEach(p => p.L || (p.L = p.life));
  onBeatOuter();
  // ring cards
  // Telemetry cards refresh incrementally when their actual values change.
  for (let i = 0; i < Math.round(2 * C.dataFlicker); i++) pick(slots).flash = rr(0.35, 0.7);
}

/* ---------- camera: automatic push-in / pull-out shots ---------- */
const cam = { x: 0, y: 0, z: 1 };
let shots = [], shotI = 0, shotT = 0, camPhase = 'hold', camFrom = null;
/* ---------- 近景目标：来源/会话绑定的真实数据卡（世界坐标） ---------- */
function cardTargetFor(agent, sessionKey) {
  const idx = ringByAgent[agent];
  if (idx == null || !RINGS[idx]) return null;
  const st = RINGS[idx];
  let best = null, bscore = 9;
  for (const sl of st.slots) {
    const bd = taskSceneState.ringBindings.get(sl);
    if (!bd || !bd.session || bd.session.source !== agent) continue;
    if (sessionKey && bd.session.id !== sessionKey) continue;
    const d = Math.abs(normA(sl.a + st.ringRot)) + (sessionKey || bd.session.status === 'running' ? 0 : 0.15);
    if (d < bscore) { bscore = d; best = sl; }
  }
  if (!best) return null;
  const ang = best.a + st.ringRot, r = st.R + (st.RO - st.R) / 2;
  return { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r };
}
/* 数据卡近景镜头：按带宽算可读缩放 + 每帧跟踪（ringRot 漂移），目标略上移避开底栏 */
function cardShotFor(agent, sessionKey, hold) {
  const idx = ringByAgent[agent];
  if (idx == null || !RINGS[idx]) return null;
  const band = RINGS[idx].RO - RINGS[idx].R;
  const z = Math.min(2.9, Math.max(2.0, (H * 0.6) / (band + 14)));
  const track = () => { const t = cardTargetFor(agent, sessionKey); return t ? { x: t.x, y: t.y + 30 / z } : null; };
  const p0 = track(); if (!p0) return null;
  return { x: p0.x, y: p0.y, z, hold, track };
}
function buildShots() {
  const P = (a, r) => ({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  const mid = (R + RO) / 2;
  const overview = { x: W / 2, y: H / 2, z: 1 };
  const fa = window.haloFollowAgent, fk = window.haloFollowKey || null;
  const inspecting = !!window.haloInspect;
  const cardShot = fa ? cardShotFor(fa, fk, inspecting ? 1e9 : 5.5) : null;
  const ringShot = !cardShot && fa && !fullCircle && ringByAgent[fa] != null ? (() => {
    // 空环聚焦：该环暂无绑定会话，仍推近其带面（左上移避开底栏）
    const st = RINGS[ringByAgent[fa]], band = st.RO - st.R;
    const z = Math.min(2.9, Math.max(2.0, (H * 0.6) / (band + 14)));
    const p = { x: cx + Math.cos(0.03) * (st.R + band / 2), y: cy + Math.sin(0.03) * (st.R + band / 2) + 30 / z };
    return { ...p, z, hold: 4.5 };
  })() : null;
  if ((cardShot || ringShot) && !fullCircle) {
    if (window.haloInspect) {
      // 检查模式：shots[0] 直接钉在卡位持续跟踪（软重建的 move 直奔 shots[0]），双击退出后恢复原节奏
      shots = [cardShot || ringShot, { ...overview, hold: 3.4 }];
    } else {
      // 跟随：总览 → 推近该来源/会话的真实数据卡（每帧跟踪）→ 回总览
      shots = [
        { ...overview, hold: window.haloAutoFollow ? 2.6 : 3.5 },
        cardShot || ringShot,
        { ...overview, hold: 3.4 },
      ];
    }
  } else if (fullCircle) {
    shots = [
      { x: W / 2, y: H / 2, z: 1, hold: 6 },
      { x: W / 2, y: H / 2, z: 1.1, hold: 5 },
      { x: W / 2, y: H / 2, z: 1, hold: 5 },
    ];
  } else {
    // 巡游：有选中会话时优先推近其数据卡，其余保持 AGT 式机位
    const selParts = agtState.selected ? agtState.selected.split(':') : null;
    const selShot = selParts && ringByAgent[selParts[0]] != null ? cardShotFor(selParts[0], agtState.selected, 4.2) : null;
    shots = [
      { ...overview, hold: 4.5 },
      ...(selShot ? [selShot] : []),
      { ...P(-thS * 0.45, mid), z: 2.3, hold: 3.4 },
      { ...P(0.04, RO + (RMAX - RO) * 0.3), z: 1.6, hold: 3.2 },
      { ...overview, hold: 3.0 },
      { ...P(0.22, R * 0.8), z: 1.9, hold: 3.4 },
      { ...P(thS * 0.5, mid + 10), z: 2.8, hold: 3.0 },
      { ...P(-0.12, RO + 40), z: 1.35, hold: 3.2 },
    ];
  }
  if (buildShots.soft && shots.length) {
    // 软重建：从当前相机位置滑向新序列开头，不瞬移
    shotI = shots.length - 1; shotT = 0; camPhase = 'move'; camFrom = { ...cam };
  } else {
    shotI = 0; shotT = 0; camPhase = 'hold';
    Object.assign(cam, shots[0]);
  }
  buildShots.soft = false;
}
function clampCam() {
  const hw = W / (2 * cam.z), hh = H / (2 * cam.z);
  cam.x = Math.max(hw, Math.min(W - hw, cam.x));
  cam.y = Math.max(hh, Math.min(H - hh, cam.y));
}
function updateCam(dt) {
  if (!C.camera) { cam.x = W / 2; cam.y = H / 2; cam.z = 1; return; }
  shotT += dt;
  const cur = shots[shotI], nxt = shots[(shotI + 1) % shots.length];
  if (camPhase === 'hold') {
    const k = shotT / cur.hold;
    const ct = cur.track ? (cur.track() || cur) : cur;
    cam.x = ct.x; cam.y = ct.y + (cur.z > 1 ? Math.sin(k * Math.PI) * 6 : 0);
    cam.z = zf(cur.z) * (1 + 0.05 * k * C.camZoom);            // slow creep while holding
    if (shotT >= cur.hold) { camPhase = 'move'; shotT = 0; camFrom = { ...cam }; }
  } else {
    const dur = 2.2, e = easeIO(Math.min(1, shotT / dur));
    const lz = Math.log(camFrom.z) + (Math.log(zf(nxt.z)) - Math.log(camFrom.z)) * e;
    let z = Math.exp(lz);
    if (camFrom.z > 1.2 && zf(nxt.z) > 1.2) z *= 1 - 0.4 * Math.sin(Math.PI * e); // pull out between two close-ups
    cam.z = Math.max(1, z);
    const nt = nxt.track ? (nxt.track() || nxt) : nxt;
    cam.x = camFrom.x + (nt.x - camFrom.x) * e;
    cam.y = camFrom.y + (nt.y - camFrom.y) * e;
    if (shotT >= dur) { shotI = (shotI + 1) % shots.length; camPhase = 'hold'; shotT = 0; }
  }
  clampCam();
}
function camT(ctx, d) { ctx.setTransform(d * cam.z, 0, 0, d * cam.z, d * (W / 2 - cam.x * cam.z), d * (H / 2 - cam.y * cam.z)); }
function camTk(ctx, d, k) {
  const z = 1 + (cam.z - 1) * k, x = W / 2 + (cam.x - W / 2) * k, y = H / 2 + (cam.y - H / 2) * k;
  ctx.setTransform(d * z, 0, 0, d * z, d * (W / 2 - x * z), d * (H / 2 - y * z));
}
const toScreen = (x, y) => ({ x: (x - cam.x) * cam.z + W / 2, y: (y - cam.y) * cam.z + H / 2 });

/* ---------- 多环上下文：withRing(i, fn) ----------
 * 引擎函数继续读写全局 R/RO/thV/thS/ringRot/rot/slots；withRing 把这些绑定切换到
 * 对应 RingState（对象引用与标量一并交换，嵌套调用后恢复原 _curRing）。
 * RingState：{id,label,R,RO,thV,thS,rot,slots,ringRot,activity,intensity,phaseOff} */
let RINGS = [];
let ringByAgent = {};
let fullCircle = true;
let _curRing = 0;
const RING_ORDER = ['codex', 'dsh', 'zcode', 'workbuddy'];
const RING_LABEL = { codex: 'Codex', dsh: 'DeepSeek', zcode: 'ZCode', workbuddy: 'WorkBuddy' };
// haloVisibleAgents 在 halo-data.js 定义
let haloFocusRing = 0;
function withRing(i, fn) {
  const st = RINGS[i]; if (!st) return;
  const sv = [R, RO, thV, thS, ringRot, slots, rot, _curRing];
  R = st.R; RO = st.RO; thV = st.thV; thS = st.thS; ringRot = st.ringRot; slots = st.slots; rot = st.rot;
  _curRing = i;
  try { fn(); } finally {
    st.ringRot = ringRot; st.slots = slots;
    R = sv[0]; RO = sv[1]; thV = sv[2]; thS = sv[3]; ringRot = sv[4]; slots = sv[5]; rot = sv[6]; _curRing = sv[7];
  }
}
function withRingEach(fn) { for (let i = 0; i < RINGS.length; i++) withRing(i, () => fn(RINGS[i], i)); }
const outerIdx = () => Math.max(0, RINGS.length - 1);

/* ---------- setup ---------- */
function mkd(w, h, d) {
  d = agtSurfaceRatio(w,h,d);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * d)); c.height = Math.max(1, Math.ceil(h * d));
  c.x = c.getContext('2d'); c.x.setTransform(d, 0, 0, d, 0, 0); return c;
}
/* 多环几何：enabled 来源从内向外 codex → dsh → zcode → workbuddy；总览一律完整 360°。
 * 外环外径目标 ≈ 短边 0.42（圈数越少单环越粗）；圈间留白 ≥ 相邻带宽的 60%。
 * 共享光场半径 = 最外环外径（全幅）：编织亮线穿过环间留白，环带不透明覆盖其上。 */
function computeRingGeometry(n) {
  // AGT 原生侧弧几何：cx=W*0.07，R=max(H*0.78,W*0.30)。
  // 多环：整体缩放使最外环仍留在可视范围内；非焦点环带宽收窄。
  const R0 = Math.max(H * 0.78, W * 0.30);
  const band0 = Math.max(90, Math.min(240, H * 0.3, W * 0.13)) * C.ringWidth;
  const RO0 = R0 + band0;
  if (n <= 1) return [{ R: R0, RO: RO0 }];
  // 缩放因子：2环 0.82，3环 0.72，4环 0.64——外环不至于把光束推出画面
  const scale = { 2: 0.82, 3: 0.72, 4: 0.64 }[n] ?? Math.max(0.5, 1 - n * 0.09);
  const gap = Math.max(18, R0 * 0.035 * scale);
  const out = [];
  let prevRO = R0 * scale;
  for (let i = 0; i < n; i++) {
    const bw = band0 * (i === 0 ? 1 : Math.max(0.45, 1 - i * 0.15)) * scale;
    const Rr = i === 0 ? R0 * scale : prevRO + gap;
    out.push({ R: Rr, RO: Rr + bw });
    prevRO = out[i].RO;
  }
  return out;
}
function rebuildRings() {
  const enabled = RING_ORDER.filter(a => window.haloVisibleAgents.has(a));
  const geo = computeRingGeometry(enabled.length);
  const prev = new Map(RINGS.map(r => [r.id, r]));
  RINGS = enabled.map((id, i) => {
    const old = prev.get(id);
    return {
      id, label: RING_LABEL[id], R: geo[i].R, RO: geo[i].RO, thV: Math.PI, thS: Math.PI,
      rot: old ? old.rot : { from: 0, to: 0, t: 1, dur: 1, hold: 0, ease: easeIO },
      ringRot: old ? old.ringRot : (i * 2.39996) % TAU,       // 各环独立相位（黄金角错开）
      slots: old ? old.slots : [],
      activity: old ? old.activity : 0, intensity: old ? old.intensity : 0,
      phaseOff: i,
    };
  });
  ringByAgent = {}; enabled.forEach((id, i) => ringByAgent[id] = i);
  fullCircle = false; _curRing = outerIdx();
  const o = RINGS[outerIdx()];
  if (o) {
    R = o.R; RO = o.RO;
    thV = Math.asin(Math.min(1, (H / 2 + 60) / Math.max(1, o.R)));
    thS = Math.asin(Math.min(1, (H / 2 + 40) / Math.max(1, o.RO)));
    o.thV = thV; o.thS = thS;
  }
  // 非最外环的 thV/thS 也在 rebuildRings 里逐环设置
  for (const r of RINGS) {
    if (r.thV === undefined) {
      r.thV = Math.asin(Math.min(1, (H / 2 + 60) / Math.max(1, r.R)));
      r.thS = Math.asin(Math.min(1, (H / 2 + 40) / Math.max(1, r.RO)));
    }
  }
  cx = W * 0.07; cy = H * 0.5;
  RMAX = Math.hypot(W - cx, H / 2) + 60;
}

function resizeStage() {
  agtReleaseStageBuffers();
  const r = stage.getBoundingClientRect();
  W = r.width; H = r.height;
  FS=Math.min(.5,Math.sqrt(agtQuality.farPixels/Math.max(1,W*H)));
  GS=Math.max(3,Math.sqrt(W*H/(agtQuality.surfacePixels*.98)));
  agtResizeStageSurfaces();
  rebuildRings();
  cx = W * 0.07; cy = H * 0.5;
  RMAX = Math.hypot(W - cx, H / 2) + 60;
  // 共享光场：半径 = 最外环外径（亮线穿越全幅，环带不透明覆盖其上）
  const WR = RINGS.length ? RINGS[outerIdx()].RO : Math.max(120, short2());
  weaveR = WR;
  withRing(0, () => { R = weaveR; buildWeb(); trailC = mkd(2 * weaveR + 4, 2 * weaveR + 4, Math.min(DPR, agtQuality.trail)); });
  withRingEach(st => { slots = st.slots; buildCards(); st.slots = slots; });   // 逐环数据带（只动本环缓存）
  // 多环：缓存上限必须覆盖全部槽位，否则各环卡片在 64 个缓存位里互踢（渲染→踢出→再渲染），环带大面积空白
  agtQuality.cardCache = Math.max(agtQuality.cardCache, RINGS.reduce((n, r) => n + r.slots.length, 0) + 16);
  withRing(outerIdx(), () => { buildLanes(); buildOuter(); });
  farC = document.createElement('canvas'); farC.width = Math.ceil(W * FS); farC.height = Math.ceil(H * FS); farC.x = farC.getContext('2d');
  glowC = document.createElement('canvas');
  glowC.width = Math.ceil(W / GS); glowC.height = Math.ceil(H / GS); glowC.x = glowC.getContext('2d');
  runners = [];
  comets = []; pulses = [];
  slots = RINGS.length ? RINGS[outerIdx()].slots : [];
  buildShots();
}
function short2() { return Math.min(W, H); }

/* withRing：上下文切换 —— 引擎函数继续读写全局 R/RO/thV/thS/ringRot/rot/slots，
 * 但实际落到对应环的状态上（标量与对象引用一并交换；嵌套后恢复原 _curRing）。 */


/* ---------- inner web ---------- */
function buildWeb() {
  const size = 2 * R + 4, d = Math.min(DPR, agtQuality.trail);
  webBase = mkd(size, size, d);
  webLayers = [0, 1, 2].map(() => mkd(size, size, d));
  const all = [webBase, ...webLayers];
  all.forEach(c => c.x.translate(R + 2, R + 2));
  const b = webBase.x;
  b.beginPath(); b.arc(0, 0, R, 0, TAU);
  const g = b.createRadialGradient(0, 0, R * 0.2, 0, 0, R);
  g.addColorStop(0, '#111215'); g.addColorStop(1, '#0c0d0f');
  b.fillStyle = g; b.fill();
  all.forEach(c => { c.x.save(); c.x.beginPath(); c.x.arc(0, 0, R, 0, TAU); c.x.clip(); });
  curves = [];
  const N = agtQuality.web;
  for (let i = 0; i < N; i++) {
    const a1 = rnd() * TAU, a2 = a1 + rr(0.6, Math.PI * 1.4);
    const p0 = { x: Math.cos(a1) * R, y: Math.sin(a1) * R };
    const p1 = { x: Math.cos(a2) * R, y: Math.sin(a2) * R };
    const cr = Math.sqrt(rnd()) * R * 0.9, ca = rnd() * TAU;
    const c = { x: Math.cos(ca) * cr, y: Math.sin(ca) * cr };
    curves.push({ p0, c, p1 });
    const layer = rnd() < 0.7 ? -1 : (rnd() * 3) | 0;
    const x = layer < 0 ? b : webLayers[layer].x;
    const al = Math.min(1, (layer < 0 ? 0.03 + Math.pow(rnd(), 3) * 0.28 : 0.08 + Math.pow(rnd(), 2) * 0.35) * C.webBright);
    const k = rnd();
    x.strokeStyle = k < 0.05 ? `rgba(240,166,198,${al})` : k < 0.1 ? `rgba(180,170,235,${al})` : `rgba(228,231,238,${al})`;
    x.lineWidth = rr(0.4, 1.1);
    x.beginPath(); x.moveTo(p0.x, p0.y); x.quadraticCurveTo(c.x, c.y, p1.x, p1.y); x.stroke();
  }
  // node markers
  b.font = `6px ${FONT}`; b.textBaseline = 'middle';
  for (let i = 0; i < 70; i++) {
    const rr_ = Math.sqrt(rnd()) * R * 0.92, a = rnd() * TAU;
    const px = Math.cos(a) * rr_, py = Math.sin(a) * rr_, s = rr(2, 4.5);
    b.strokeStyle = `rgba(235,238,244,${rr(0.35, 0.8)})`; b.lineWidth = 0.8;
    b.beginPath(); b.arc(px, py, s, 0, TAU); b.stroke();
    if (rnd() < 0.4) { b.beginPath(); b.arc(px + s * 2.2, py, s * 0.8, 0, TAU); b.stroke(); }

  }
  // dotted chains of small rings (as in the original)
  for (let k = 0; k < 3; k++) {
    const rad = R * rr(0.45, 0.85), a0 = rr(0, TAU), cnt = 22 + (rnd() * 14 | 0);
    b.strokeStyle = 'rgba(235,238,244,.55)'; b.lineWidth = 0.8;
    for (let i = 0; i < cnt; i++) { const a = a0 + i * 0.022; b.beginPath(); b.arc(Math.cos(a) * rad, Math.sin(a) * rad, 2.2, 0, TAU); b.stroke(); }
  }
  all.forEach(c => c.x.restore());
  if (HAS_FILTER && C.webBlur > 0) {
    all.forEach((c, i) => {
      const orig = document.createElement('canvas'); orig.width = c.width; orig.height = c.height; orig.getContext('2d').drawImage(c, 0, 0);
      const x = c.x; x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height);
      x.filter = `blur(${(i ? 0.5 : 1) * C.webBlur * d}px)`; x.drawImage(orig, 0, 0); x.filter = 'none';
      x.globalAlpha = Math.max(0.15, 1 - C.webBlur * 0.3); x.drawImage(orig, 0, 0); x.restore();
      orig.width=1;orig.height=1;
    });
  }
}
const qpt = (cv, t) => {
  const u = 1 - t;
  return { x: u * u * cv.p0.x + 2 * u * t * cv.c.x + t * t * cv.p1.x, y: u * u * cv.p0.y + 2 * u * t * cv.c.y + t * t * cv.p1.y };
};
function newRunner(init) {
  const cv = pick(curves), t = init ? rnd() : 0, p = qpt(cv, t);
  // mixed speed personalities so lone lines never move in lockstep
  const k = rnd(); let mode, sp;
  if (rnd() > C.runnerVariety) { mode = 1; sp = rr(0.12, 0.38); }   // uniform (version A style)
  else if (k < 0.3) { mode = 0; sp = rr(0.15, 0.28); }        // steady, ignores the beat
  else if (k < 0.65) { mode = 1; sp = rr(0.1, 0.3); }    // surges on the beat
  else if (k < 0.8) { mode = 0; sp = rr(0.04, 0.08); }   // slow drift
  else if (k < 0.92) { mode = 0; sp = rr(0.5, 0.85); }   // fast streak
  else { mode = 2; sp = rr(0.06, 0.12); }                 // accelerates along its path
  return { cv, t, sp, mode, px: p.x, py: p.y, b: rnd() < 0.1 };
}

/* ---------- comets: short bright bundles sweeping with ease-in-out ---------- */
function spawnComet(ringIdx) {
  const ri = ringIdx == null ? (RINGS.length ? (rnd() * RINGS.length) | 0 : 0) : ringIdx;
  if (!RINGS[ri]) return;
  withRing(ri, () => {
  const lines = [], n = Math.max(2, Math.round((8 + (rnd() * 12 | 0)) * C.cometLines));
  if (rnd() < 0.6) {
    // concentric arc bundle hugging the ring
    const rad = R * rr(0.55, 0.9), a0 = rr(-thV, thV) * 0.85, span = rr(0.35, 0.9) * (rnd() < 0.5 ? -1 : 1), gap = rr(2.6, 4.4) * C.cometWidth;
    for (let k = 0; k < n; k++) lines.push({ arc: true, r: rad - k * gap + gauss() * 0.6, a0: a0 + gauss() * 0.01, span });
  } else {
    // converging bundle: inner point → ring edge
    const ang = rr(-thV, thV) * 0.8, oa = ang + rr(-1.3, 1.3), orad = R * rr(0.25, 0.75);
    const o = { x: Math.cos(oa) * orad, y: Math.sin(oa) * orad };
    const spread = rr(0.08, 0.25) * C.cometWidth, bend = rr(0.2, 0.5) * (rnd() < 0.5 ? -1 : 1);
    for (let i = 0; i < n; i++) {
      const ta = ang + (i / n - 0.5) * spread;
      const p1 = { x: Math.cos(ta) * (R - 2), y: Math.sin(ta) * (R - 2) };
      const p0 = { x: o.x + gauss() * 10, y: o.y + gauss() * 10 };
      const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2, dx = p1.x - p0.x, dy = p1.y - p0.y;
      lines.push({ p0, c: { x: mx - dy * bend + gauss() * 8, y: my + dx * bend + gauss() * 8 }, p1 });
    }
  }
  comets.push({ lines, life: 0, hit: false, rot0: ringRot, dur: rr(0.4, 0.85) / C.cometSpeed, win: rr(0.22, 0.4), glow: rnd() < 0.4, tint: rnd() < 0.15, ring: _curRing, ringId: RINGS[_curRing] ? RINGS[_curRing].id : null });
  });
}
/* E: Agent 身份色彗星——沿用项目既有色值（modelColor/PALETTE）：Codex 银白、DeepSeek 冰蓝、ZCode 琥珀、WorkBuddy 青绿 */
function agentIdentityRgb(agent) {
  const M = { codex: [223, 230, 238], dsh: [110, 200, 232], zcode: [230, 168, 66], workbuddy: [152, 224, 207] };
  return M[agent] || [223, 230, 238];
}
function agentCometTarget(agent) {
  const idx = ringByAgent[agent];
  if (idx == null || !RINGS[idx]) return null;
  const st = RINGS[idx];
  let best = null, bscore = 9;
  for (const sl of st.slots) {
    const bd = taskSceneState.ringBindings.get(sl);
    if (!bd || !bd.session || bd.session.source !== agent) continue;
    const d = Math.abs(normA(sl.a + st.ringRot)) + (bd.session.status === 'running' ? 0 : 0.2);   // 世界角：可见弧面在世界坐标固定，环 rot 随时间累积
    if (d < bscore) { bscore = d; best = sl; }
  }
  return best;   // 槽位局部角 slot.a；绘制时 followRot-rot0 自动跟随环旋转
}
function spawnAgentComet(agent) {
  const idx = ringByAgent[agent];
  if (idx == null || !RINGS[idx]) return;
  const slot = agentCometTarget(agent);
  if (!slot) return;
  withRing(idx, () => {
    if (!haloSessionsOf(agent).some(s=>s.status==='running')) return;
    if (comets.filter(c=>c.agent===agent).length>=2) return;
    const lines = [], n = Math.max(2, Math.round((8 + (rnd() * 10 | 0)) * C.cometLines));
    // 终点局部角 = slot.a + 生成时 ringRot：绘制按 (当前rot-rot0) 旋转后恰落在卡上（同 flashSlotAt 空间）
    const originRadius=Math.max(30,Math.min(...RINGS.map(r=>r.R))-24);
    const ang = slot.a + ringRot, orad = originRadius * rr(0.2, 0.6), oa = ang + rr(-1.1, 1.1);
    const o = { x: Math.cos(oa) * orad, y: Math.sin(oa) * orad };
    const spread = rr(0.06, 0.16) * C.cometWidth, bend = rr(0.2, 0.5) * (rnd() < 0.5 ? -1 : 1);
    for (let i = 0; i < n; i++) {
      const la = ang + (i / n - 0.5) * spread;
      const p1 = { x: Math.cos(la) * (R + (RO - R) * 0.5), y: Math.sin(la) * (R + (RO - R) * 0.5) };
      const p0 = { x: o.x + gauss() * 10, y: o.y + gauss() * 10 };
      const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2, dx = p1.x - p0.x, dy = p1.y - p0.y;
      lines.push({ p0, c: { x: mx - dy * bend + gauss() * 8, y: my + dx * bend + gauss() * 8 }, p1 });
    }
    comets.push({ lines, life: 0, hit: false, rot0: ringRot, dur: rr(0.9, 1.7) / C.cometSpeed, win: rr(0.22, 0.4), glow: true, tint: false, ring: idx, ringId: agent, agent, identity: agentIdentityRgb(agent).join(',') });
  });
}
const cpt = (l, t) => { if (!l.arc) return qpt(l, t); const r = l.r + (R - 2 - l.r) * t * t, a = l.a0 + l.span * t; return { x: Math.cos(a) * r, y: Math.sin(a) * r }; };
function strokeComet(ctx, c, t0, t1, steps) {
  ctx.beginPath();
  for (const l of c.lines) for (let s = 0; s <= steps; s++) {
    const p = cpt(l, t0 + (t1 - t0) * (s / steps));
    s ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  }
  ctx.stroke();
}

/* ---------- outer: stacked, constantly changing layers ----------
   L0 haze bands (translucent wide wedges, additive, short lifecycles)
   L1 far strands (thin, dim, slower rotation → parallax)
   L2 main strands (dense, ring-attached, staircase tips + flowing dashes)
   L3 root flares (bright white blocks at the ring edge, glow)          */
let GR = {}, strandLayers = [], hazes = [], flares = [];
const HAZE_COL = ['196,180,252', '242,242,252', '190,222,222'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const normA = a => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
function makeProfile(n) {
  const prof = []; let v = rr(0.45, 1), run = 0;
  for (let k = 0; k < n; k++) {
    if (run-- <= 0) { v = clamp(v + gauss() * 0.4, 0.22, 1); run = 2 + (rnd() * 5 | 0); }
    prof.push(clamp(v + gauss() * 0.07, 0.18, 1));
  }
  return prof;
}
function makeStrandLayer(stepDeg, rotK, lumK, lw, lenK, solidK, cover, nMin, nMax, brightP, dyn = 'soft') {
  const step = stepDeg * Math.PI / 180, nb = Math.floor(TAU / step), ws = [];
  const count = Math.round(nb * cover / ((nMin + nMax) / 2));
  for (let j = 0; j < count; j++) {
    const n = nMin + (rnd() * (nMax - nMin) | 0), bright = rnd() < brightP;
    ws.push({
      i0: (rnd() * nb) | 0, n, base: rr(0.35, 1), len: rr(0.1, 0.5), kick: 0,
      ph: rnd() * TAU, ph2: rnd() * TAU, f1: rr(0.22, 0.6), f2: rr(0.8, 1.7),
      lum: bright ? rr(0.75, 1) : rr(0.16, 0.55), tint: rnd() < 0.5 ? 1 : 0,
      lwK: rnd() < 0.2 ? rr(1.35, 2.1) : rr(0.6, 1.15), lenS: rr(0.6, 1.25),
      prof: makeProfile(n), pf: Array.from({ length: n }, () => rr(1, 4)), pp: Array.from({ length: n }, () => rnd() * TAU),
      ds: Array.from({ length: n }, () => rnd()), dsp: rr(0.7, 1.8), flow: 0
    });
  }
  return { step, rotK, lumK, lw, lenK, solidK, wedges: ws, off: rnd() * TAU, dyn };
}
function buildOuter() {
  strandLayers = [
    //               step  rotK  lumK  lw    lenK  solidK cover nMin nMax brightP
    makeStrandLayer(0.22, 0.45, 0.30, 0.55, 1.15, 0.9,  1.1,  20,  90, 0.2),   // far: faint, thin, slow
    makeStrandLayer(0.16, 0.75, 0.58, 0.8,  1.05, 0.7,  0.9,  14,  70, 0.28),  // mid
    makeStrandLayer(0.12, 1.0,  1.0,  1.0,  1.0,  0.5,  0.75, 12,  60, 0.32),  // main (dashes + tips)
    makeStrandLayer(0.45, 1.0,  0.5,  1.8,  0.8,  0.6,  0.35, 4,   16, 0.3),   // near: few thick strokes
    makeStrandLayer(0.12, 1.0,  0.85, 1.0,  1.0,  0.5,  0.55, 14,  70, 0.32, 'bounce'),  // v4 wave / rebound layer
  ];
  wedges = strandLayers[2].wedges.concat(strandLayers[4].wedges);
  hazes = []; flares = [];
  GR = {};
  const mkG = (stops, r1) => { const g = S.createRadialGradient(cx, cy, RO, cx, cy, r1); stops.forEach(s => g.addColorStop(s[0], s[1])); return g; };
  GR.s0 = mkG([[0, 'rgba(248,248,255,1)'], [0.35, 'rgba(228,226,242,.8)'], [1, 'rgba(190,190,214,.3)']], RMAX * 0.95);
  GR.s2 = mkG([[0, 'rgba(225,245,242,1)'], [0.3, 'rgba(176,214,210,.8)'], [1, 'rgba(140,180,186,.3)']], RMAX * 0.95);
  GR.s1 = mkG([[0, 'rgba(240,236,255,1)'], [0.3, 'rgba(196,182,244,.82)'], [1, 'rgba(160,140,228,.3)']], RMAX * 0.95);
  // haze tints: lavender / pale white / grey-teal
  GR.h0 = mkG([[0, 'rgba(205,190,255,.95)'], [0.25, 'rgba(180,165,240,.7)'], [0.7, 'rgba(150,135,215,.25)'], [1, 'rgba(120,110,190,0)']], RMAX);
  GR.h1 = mkG([[0, 'rgba(250,250,255,1)'], [0.2, 'rgba(225,225,240,.65)'], [0.65, 'rgba(200,200,225,.2)'], [1, 'rgba(180,180,210,0)']], RMAX);
  GR.h2 = mkG([[0, 'rgba(200,230,228,.9)'], [0.25, 'rgba(170,205,210,.6)'], [0.7, 'rgba(140,170,185,.2)'], [1, 'rgba(120,150,170,0)']], RMAX);
  for (let i = 0; i < 14; i++) spawnHaze(true);
  initFlyers();
}
function spawnHaze(init) {
  const k = rnd();
  hazes.push({
    a: rr(-thS, thS) - ringRot, w: rnd() < 0.7 ? rr(0.015, 0.07) : rr(0.08, 0.18),
    len: rr(0.35, 1), cur: init ? rr(0.2, 0.8) : 0, age: init ? rr(0, 0.5) : 0,
    life: rr(0.35, 1.6), alpha: rr(0.12, 0.42), tint: k < 0.55 ? 0 : k < 0.85 ? 1 : 2, drift: rr(-0.04, 0.04)
  });
}
function spawnFlare(a) {
  flares.push({ a: a == null ? rr(-thS, thS) * 0.95 - ringRot : a, w: rr(0.006, 0.04), len: rr(18, 110), age: 0, life: rr(0.2, 0.55), alpha: rr(0.6, 1) });
}
function buildLanes() {
  laneC = mkd(W, H, DPR);
  const x = laneC.x;
  for (let i = 0; i < 700; i++) {
    const a = rr(-thS, thS);
    x.strokeStyle = `rgba(210,205,235,${rr(0.01, 0.035)})`; x.lineWidth = rr(0.5, 1);
    const r0 = RO + 4, r1 = rr(RO + 60, RMAX * 0.8);
    x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); x.stroke();
  }
}
function updateOuter(dt) {
  for (let i = pulses.length - 1; i >= 0; i--) { const p = pulses[i]; p.c += p.v * dt; p.life -= dt; if (p.life <= 0) pulses.splice(i, 1); }
  for (const Lr of strandLayers) {
    const rot = ringRot * Lr.rotK + Lr.off;
    for (const w of Lr.wedges) {
      const am = normA((w.i0 + w.n / 2) * Lr.step + rot);
      w.vis = Math.abs(am) < thS + 0.2;
      w.flow += dt * w.dsp * (0.45 + 2.2 * env);
      if (!w.vis) { w.len *= 0.98; continue; }
      let p = 0;
      for (const pl of pulses) { const f = Math.min(1, pl.life / 0.5) * Math.min(1, (pl.L - pl.life) / 0.15 + 0.3); p += pl.amp * f * Math.exp(-(((am - pl.c) / pl.w) ** 2)); }
      if (Lr.dyn === 'bounce') {
        const idle = w.base * (0.36 + 0.14 * Math.sin(T * 0.9 + w.ph));
        const tgt = Math.min(1, idle + p * 0.75 + w.kick * 0.6);
        w.kick *= Math.exp(-dt * 2.4);
        w.len += (tgt - w.len) * Math.min(1, (tgt > w.len ? 15 : 2.2) * dt);   // snap out on the wave, ease back
      } else {
        const n1 = 0.5 + 0.5 * Math.sin(T * w.f1 + w.ph), n2 = 0.5 + 0.5 * Math.sin(T * w.f2 + w.ph2);
        const idle = w.base * (0.4 + 0.34 * n1 + 0.14 * n2);
        const tgt = Math.min(1.05, (idle + p * 0.7 + w.kick * 0.55) * w.lenS);
        w.kick *= Math.exp(-dt * 1.8);
        w.len += (tgt - w.len) * Math.min(1, (tgt > w.len ? 5 : 1.3) * dt);
      }
    }
  }
  // haze lifecycle
  for (let i = hazes.length - 1; i >= 0; i--) {
    const h = hazes[i]; h.age += dt;
    h.cur += (h.len - h.cur) * Math.min(1, 9 * dt);
    if (h.age > h.life + 0.6) hazes.splice(i, 1);
  }
  if (hazes.length < C.hazeCount && rnd() < 0.25) spawnHaze(false);
  for (let i = flares.length - 1; i >= 0; i--) { flares[i].age += dt; if (flares[i].age > flares[i].life) flares.splice(i, 1); }
  if (rnd() < 0.06 * C.flareRate) spawnFlare();
  updateFlyers(dt);
}
function onBeatOuter() {
  onBeatFlyers();
  for (let i = 0; i < 2 + (rnd() * 5 | 0); i++) { const w = pick(wedges); w.kick = rr(0.4, 1); if (rnd() < 0.5) w.prof = makeProfile(w.n); }
  for (let i = 0; i < 2; i++) { const w = pick(wedges); w.lum = rnd() < 0.4 ? rr(0.8, 1) : rr(0.25, 0.6); }
  const nh = beatN % 4 === 0 ? 5 + (rnd() * 4 | 0) : 1 + (rnd() * 3 | 0);
  for (let i = 0; i < Math.round(nh * C.hazeCount / 8); i++) spawnHaze(false);
  const nf = Math.round((1 + (rnd() * 4 | 0)) * C.flareRate);
  for (let i = 0; i < nf; i++) spawnFlare(hazes.length && rnd() < 0.6 ? pick(hazes).a : null);
}
function hazeEnv(h) {
  const a = Math.min(1, h.age / 0.12);                       // fast in
  const o = h.age > h.life ? Math.max(0, 1 - (h.age - h.life) / 0.6) : 1; // slower out
  return a * o * (0.85 + 0.15 * Math.sin(h.age * 30));      // slight flicker
}
const EDGE_A = [0.28, 0.62, 1];
function drawStrands(Lr, collect) {
  const span = RMAX - RO - 20, r0 = RO + 3, rot = ringRot * Lr.rotK + Lr.off;
  S.lineCap = 'butt';
  for (const w of Lr.wedges) {
    if (!w.vis) continue;
    const L = w.len * span * Lr.lenK * C.beamLen;
    if (L < 3) continue;
    const a0 = normA(w.i0 * Lr.step + rot), a1 = a0 + w.n * Lr.step;
    if (a1 < -thS - 0.03 || a0 > thS + 0.03) continue;
    const alpha = Math.min(1, w.lum * Lr.lumK * (0.3 + 0.7 * Math.min(1, w.len * 1.8)) * C.beamBright * (Lr.dyn === 'bounce' ? C.beamBounce : 1));
    if (alpha < 0.005) continue;
    const lwW = Lr.lw * w.lwK * C.beamWidth;
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    for (let k = 0; k < w.n; k+=agtFxStride()) {
      const a = a0 + (k + 0.5) * Lr.step, ca = Math.cos(a), sa = Math.sin(a);
      const edge = Math.sin(Math.PI * (k + 0.5) / w.n), b = edge < 0.38 ? 0 : edge < 0.72 ? 1 : 2;
      const pr = w.prof[k];
      const l = L * pr * (0.5 + 0.5 * Math.sqrt(edge)) * (0.92 + 0.08 * Math.sin(T * w.pf[k] + w.pp[k]));
      const solid = l * (Lr.solidK + 0.3 * pr * (1 - Lr.solidK));
      paths[b].moveTo(cx + ca * r0, cy + sa * r0); paths[b].lineTo(cx + ca * (r0 + solid), cy + sa * (r0 + solid));
      if (!collect) continue;
      const tail = l - solid, da = alpha * EDGE_A[b];
      if (tail > 6) for (let d = 0; d < 2; d++) {
        const ph = (w.flow + w.ds[k] + d * 0.5) % 1;
        const s0 = solid + tail * ph, s1 = Math.min(l, s0 + 3 + tail * 0.22 * (1 - ph * 0.5));
        if (s1 > s0) collect.dash.push(ca, sa, s0, s1, da);
      }
      if ((k + (T * 12 | 0)) % 4 === 0) collect.tip.push(ca, sa, l, da);
    }
    S.strokeStyle = GR['s' + w.tint]; S.lineWidth = lwW;
    for (let b = 0; b < 3; b++) { S.globalAlpha = alpha * EDGE_A[b]; S.stroke(paths[b]); }
    if (w.lum > 0.85 && C.beamGlow > 0) { S.globalAlpha = Math.min(1, alpha * 0.06 * C.beamGlow); S.lineWidth = lwW * 2.5; S.stroke(paths[2]); }
  }
}
const hash = x => { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s); };
function radialLines(a0, a1, st, r0, L, seed, lo) {
  S.beginPath();
  let k = 0;
  for (let a = a0; a < a1; a += st, k++) {
    const l = L * (lo + (1 - lo) * hash(k + seed)), ca = Math.cos(a), sa = Math.sin(a);
    S.moveTo(cx + ca * r0, cy + sa * r0); S.lineTo(cx + ca * (r0 + l), cy + sa * (r0 + l));
  }
}
/* ---- fly-out streaks: shoot outward and never retract, interleaved with the beams ----
   singles: sparse, dimmer, respawn forever
   bursts : packets of parallel streaks launched together on the beat, brighter, die at the edge */
let flyers = [], flyBands = [];
function newFlyBand() { return { a: rr(-thS, thS), w: rr(0.01, 0.05), life: rr(2, 6) }; }
function newFlyer(init) {
  let a;
  if (rnd() < 0.5) { const b = pick(flyBands); a = b.a + gauss() * b.w; } else a = rr(-thS, thS);
  return {
    a: a - ringRot, len: 20 + Math.pow(rnd(), 2) * 320, r: init ? rr(RO, RMAX) : RO + rr(0, 25),
    sp: rr(260, 900), lw: rnd() < 0.08 ? rr(1.2, 1.7) : rr(0.5, 1), lv: rnd() < 0.12 ? 1 : 0, tint: rnd() < 0.22 ? 1 : 0, burst: false
  };
}
function spawnFlyBurst() {
  const a = rr(-thS, thS) * 0.95, n = Math.max(1, Math.round((14 + (rnd() * 30 | 0)) * C.burstSize)), spread = rr(0.01, 0.045);
  const sp = rr(450, 1150), len = rr(70, 320), r0 = RO + rr(0, 8), tint = rnd() < 0.3 ? 1 : 0, lv = rnd() < 0.45 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    flyers.push({
      a: a + (i / n - 0.5) * spread + gauss() * 0.0015 - ringRot, len: len * rr(0.7, 1.15), r: r0 - rr(0, len * 0.35),
      sp: sp * rr(0.92, 1.08), lw: rnd() < 0.2 ? 1.3 : rr(0.6, 1), lv, tint, burst: true
    });
  }
}
function initFlyers() {
  flyBands = Array.from({ length: 7 }, newFlyBand);
  flyers = Array.from({ length: Math.round(Math.min(750, 320 + W * 0.25) * C.flyerCount) }, () => newFlyer(true));
}
function updateFlyers(dt) {
  for (const b of flyBands) { b.life -= dt; if (b.life <= 0) Object.assign(b, newFlyBand()); }
  const k = (0.7 + 0.9 * env) * C.flyerSpeed;
  for (let i = flyers.length - 1; i >= 0; i--) {
    const f = flyers[i];
    f.r += f.sp * dt * k;
    if (f.r - f.len > RMAX) { if (f.burst) flyers.splice(i, 1); else flyers[i] = newFlyer(false); }
  }
}
function onBeatFlyers() {
  const n = Math.round((beatN % 4 === 0 ? 3 + (rnd() * 2 | 0) : 1 + (rnd() * 2 | 0)) * C.burstRate);
  for (let i = 0; i < n; i++) setTimeout(spawnFlyBurst, i * rr(20, 120));
}
const FLY_A = [0.16, 0.36, 0.7];
function drawFlyers(bursts) {
  const buckets = {};
  for (const f of flyers) {
    if (f.burst !== bursts) continue;
    const a = normA(f.a + ringRot);
    if (a < -thS - 0.05 || a > thS + 0.05) continue;
    const key = f.tint * 10 + f.lv + (f.lw > 1.15 ? 100 : 0) + (f.burst ? 1000 : 0);
    (buckets[key] || (buckets[key] = [])).push(f, a);
  }
  for (const key in buckets) {
    const arr = buckets[key], f0 = arr[0];
    S.strokeStyle = f0.tint ? GR.s1 : GR.s0; S.globalAlpha = Math.min(1, FLY_A[f0.lv] * (f0.burst ? C.burstBright : C.flyerBright)); S.lineWidth = ((key % 1000) >= 100 ? 1.5 : 0.8) * C.flyerWidth;
    S.beginPath();
    for (let i = 0; i < arr.length; i += 2) {
      const f = arr[i], a = arr[i + 1], r0 = Math.max(RO + 3, f.r - f.len), r1 = f.r;
      if (r1 <= r0) continue;
      const ca = Math.cos(a), sa = Math.sin(a);
      S.moveTo(cx + ca * r0, cy + sa * r0); S.lineTo(cx + ca * r1, cy + sa * r1);
    }
    S.stroke();
  }
  S.globalAlpha = 1;
}
function drawOuterFar() {
  const span = RMAX - RO - 20, r0 = RO + 3;
  // haze bundles 鈥?very dense, faint lines that merge into soft bands
  for (const h of hazes) {
    const e = hazeEnv(h); if (e <= 0.01) continue;
    if (h.seed === undefined) h.seed = rnd() * 1000;
    const L = h.cur * span;
    radialLines(h.a + ringRot - h.w / 2, h.a + ringRot + h.w / 2, OSTEP * 0.55, r0, L, h.seed, 0.45);
    S.strokeStyle = GR['s' + (h.tint === 1 ? 0 : h.tint === 2 ? 2 : 1)];
    S.globalAlpha = Math.min(1, h.alpha * e * 0.05 * C.hazeBright); S.lineWidth = 2.2; S.stroke();
    S.globalAlpha = Math.min(1, h.alpha * e * 0.6 * C.hazeBright); S.lineWidth = 0.55; S.stroke();
  }
  drawStrands(strandLayers[0], null);   // far strands
  drawStrands(strandLayers[1], null);   // mid strands
  drawFlyers(false);                    // single fly-outs live in the background
  S.globalAlpha = 1;
}
function drawOuterNear() {
  const r0 = RO + 3;
  const col = { dash: [], tip: [] };
  drawStrands(strandLayers[2], col);
  drawStrands(strandLayers[4], col);   // wave / rebound layer
  drawStrands(strandLayers[3], null);   // near thick strokes
  S.strokeStyle = '#fff'; S.lineWidth = 1.05;
  for (const lv of [0.35, 0.65, 1]) {
    S.globalAlpha = Math.min(1, lv * C.dashBright); S.beginPath();
    const dp = col.dash;
    for (let i = 0; i < dp.length; i += 5) {
      const a = dp[i + 4]; if (a > lv || a <= lv - 0.35) continue;
      S.moveTo(cx + dp[i] * (r0 + dp[i + 2]), cy + dp[i + 1] * (r0 + dp[i + 2])); S.lineTo(cx + dp[i] * (r0 + dp[i + 3]), cy + dp[i + 1] * (r0 + dp[i + 3]));
    }
    S.stroke();
  }
  S.fillStyle = '#fff';
  for (let i = 0; i < col.tip.length; i += 4) {
    S.globalAlpha = Math.min(1, col.tip[i + 3] * 1.2);
    const r = r0 + col.tip[i + 2];
    S.fillRect(cx + col.tip[i] * r - 0.8, cy + col.tip[i + 1] * r - 0.8, 1.6, 1.6);
  }
  drawFlyers(true);                     // burst packets are in the foreground
  S.strokeStyle = GR.s0;
  for (const f of flares) {
    if (f.seed === undefined) f.seed = rnd() * 1000;
    const t = f.age / f.life, e = (t < 0.15 ? t / 0.15 : Math.pow(1 - (t - 0.15) / 0.85, 2)) * f.alpha;
    const L = f.len * (0.6 + 0.4 * easeO(Math.min(1, t * 3)));
    radialLines(f.a + ringRot - f.w / 2, f.a + ringRot + f.w / 2, OSTEP * 0.45, r0, L, f.seed, 0.4);
    S.globalAlpha = Math.min(1, e * 0.06 * C.flareBright); S.lineWidth = 2.6; S.stroke();
    S.globalAlpha = Math.min(1, e * C.flareBright); S.lineWidth = 0.8; S.stroke();
  }
  S.globalAlpha = 1;
}

/* ---------- foreground bokeh: out-of-focus specks closest to the viewer ---------- */
let bokehs = [], bokehSpr = null;
function mkBokehSprite() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(0.5, 'rgba(235,232,255,.5)'); g.addColorStop(0.82, 'rgba(220,215,255,.22)');
  g.addColorStop(0.93, 'rgba(225,220,255,.32)'); g.addColorStop(1, 'rgba(220,215,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128); return c;
}
function newBokeh() {
  const big = rnd() < 0.3;
  return { x: rr(-0.1, 1.1) * W, y: rr(-0.1, 1.1) * H, r: big ? rr(24, 64) : rr(5, 22), a: big ? rr(0.025, 0.07) : rr(0.05, 0.16),
    vx: rr(-10, 10), vy: rr(-6, 6), st: rnd() < 0.3 ? rr(2, 5) : 1, ph: rnd() * TAU };
}
function drawBokeh(dt) {
  const n = Math.round(C.bokeh);
  while (bokehs.length < n) bokehs.push(newBokeh());
  if (bokehs.length > n) bokehs.length = n;
  if (!n) return;
  if (!bokehSpr) bokehSpr = mkBokehSprite();
  const k = 1 + 0.6 * C.parallax, z = 1 + (cam.z - 1) * k, ox = (cam.x - W / 2) * k, oy = (cam.y - H / 2) * k;
  S.setTransform(DPR, 0, 0, DPR, 0, 0); S.globalCompositeOperation = 'lighter';
  for (const b of bokehs) {
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (b.x < -0.15 * W) b.x += 1.3 * W; if (b.x > 1.15 * W) b.x -= 1.3 * W;
    if (b.y < -0.15 * H) b.y += 1.3 * H; if (b.y > 1.15 * H) b.y -= 1.3 * H;
    const sx = (b.x - W / 2 - ox) * z + W / 2, sy = (b.y - H / 2 - oy) * z + H / 2, r = b.r * z;
    S.globalAlpha = Math.min(1, b.a * C.bokehBright * (0.75 + 0.25 * Math.sin(T * 0.8 + b.ph)) * (1 + env * 0.3));
    S.drawImage(bokehSpr, sx - r * b.st, sy - r, 2 * r * b.st, 2 * r);
  }
  S.globalAlpha = 1; S.globalCompositeOperation = 'source-over';
}
/* ---------- ring: pre-rendered dot-matrix data blocks on a black band ---------- */
const RING_SC = 2.4;
let slots = [];
const easeOX = t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
let rot = { from: 0, to: 0, t: 1, dur: 1, hold: 0, ease: easeIO };
function ringMove() {
  const r = rnd(); let d, dur, ease;
  if (r < 0.22) { d = rr(1.1, 2.1); dur = rr(0.7, 1.05); ease = easeIO; }        // fast spin
  else if (r < 0.64) { d = rr(0.14, 0.48); dur = rr(0.18, 0.38); ease = easeOX; } // snap & stop
  else { d = rr(0.05, 0.18); dur = rr(0.3, 0.6); ease = easeIO; }               // small nudge
  if (rnd() < 0.08) d = -d * 0.5;  d *= C.ringSpeed;
  Object.assign(rot, { from: ringRot, to: ringRot + d, t: 0, dur, ease, hold: rr(0.04, 0.4) * C.ringPause });
}
function flashSlotAt(ringIdx, ang) {
  const st = RINGS[ringIdx]; if (!st) return;
  let best = null, bd = 9;
  for (const sl of st.slots) { const d = Math.abs(normA(sl.a + st.ringRot - ang)); if (d < bd) { bd = d; best = sl; } }
  if (best && bd < 0.08) best.flash = Math.max(best.flash, 0.8);
}
function updateRing(dt) {
  if (rot.t < rot.dur) { rot.t += dt; ringRot = rot.from + (rot.to - rot.from) * rot.ease(Math.min(1, rot.t / rot.dur)); }
  else { rot.hold -= dt; ringRot += 0.02 * dt; }
}
function buildCards() {
  releaseTaskCards(slots);   // 只释放当前环的卡片缓存与绑定（多环隔离）
  slots = [];
  const band = RO - R, mid = R + band * 0.42;
  let a = 0;
  while (a < TAU - 0.03) {
    const hpx = rr(16, 62), da = hpx / mid, gap = rr(3, 9) / mid;
    slots.push({ a: a + da / 2, da, hpx, c: null, flash: 0 });
    a += da + gap;
  }
  Object.assign(rot, { from: 0, to: 0, t: 1, dur: 1, hold: 0 });
}
const TINTS = [[232, 234, 240], [232, 234, 240], [232, 234, 240], [232, 234, 240], [232, 234, 240], [232, 234, 240], [196, 184, 246], [196, 184, 246], [168, 222, 214], [206, 212, 150]];
const HEAD = ['SOLVER/02', 'EXTRACT', 'REF.SCENE 07', 'METHOD M04', 'CHECK', 'RESIDUAL', 'PAPER 37', 'AGENT 09', 'BUFFER A',
  'DIFF FIELD', 'STEP 1284', 'MESH 64x64', 'PROJECT', 'ADVECT', 'BC / WALL', 'LBM D2Q9', 'QUEUE', 'TRACE', 'EQ.(4)', 'FIG.3', 'VALIDATE', 'SCENE 12'];
const KEYS = ['dt', 'CFL', 'nu', 'Re', 'tol', 'iter', 'L2', 'mass', 'div', 'u_max', 'rho', 'err', 'grid', 'seed'];
const CODE_T = ['load()', 'step(u)', 'proj(p)', 'bc.apply', 'solve()', 'grad p', 'div u', 'assert', 'f_eq', 'stream', 'collide', 'ok', 'PASS',
  'ref#12', 'diff', 'L2<tol', 'u*', '->', '==', 'dt/2', 'emit', 'push', 'read', 'fig3', 'eq4'];
const rgba = (t, a) => `rgba(${t[0]},${t[1]},${t[2]},${a})`;
const fmtNum = () => { const k = rnd(); return k < 0.3 ? rr(0, 1).toFixed(3) : k < 0.55 ? (rr(1, 9).toFixed(1) + 'e-' + (2 + (rnd() * 5 | 0))) : k < 0.8 ? String((rnd() * 9999) | 0) : rr(0, 100).toFixed(1); };
function glyphStrips(x, x1, y0, y1, pitch, opt, ctx) {
  const tint = opt.tint;
  for (let lx = x; lx < x1 - 1; lx += pitch) {
    if (opt.colGap && rnd() < 0.18) { lx += pitch * 0.8; continue; }
    const len = (y1 - y0) * (opt.ragged ? rr(0.35, 1) : rr(0.85, 1));
    const start = opt.ragged && rnd() < 0.3 ? y0 + rr(0, (y1 - y0) * 0.3) : y0;
    let y = start;
    const lb = rr(0.55, 1);
    while (y < Math.min(y1, start + len)) {
      const cl = opt.solid ? rr(2, 6) : rr(0.9, 2.2);
      if (rnd() < 0.9) { ctx.fillStyle = rgba(tint, lb * rr(0.6, 1)); ctx.fillRect(lx, y, opt.th, Math.min(cl, y1 - y)); }
      y += cl + (rnd() < 0.12 ? rr(1.5, 3) : rr(0.5, 0.9));
    }
  }
}
// ---- block renderers: (ctx, x0, x1, y0, y1, tint) — x is radial, y is tangential ----
function header(c, x0, x1, y, t) {
  c.font = `700 4.3px ${FONT}`; c.fillStyle = rgba(t, 0.95); c.fillText(pick(HEAD), x0, y);
  c.fillStyle = rgba(t, 0.55); c.fillText(String((rnd() * 99) | 0).padStart(2, '0'), x1 - 6, y);
  c.fillStyle = rgba(t, 0.3); c.fillRect(x0, y + 5.6, x1 - x0, 0.45);
  return y + 7.5;
}
const BLOCKS = {
  code(c, x0, x1, y0, y1, t) {
    let y = header(c, x0, x1, y0, t);
    c.font = `500 3.5px ${FONT}`;
    let n = 1 + (rnd() * 40 | 0);
    while (y < y1 - 3.5) {
      c.fillStyle = rgba(t, 0.3); c.fillText(String(n++).padStart(3, '0'), x0, y);
      let xx = x0 + 9;
      const words = 1 + (rnd() * 4 | 0);
      for (let i = 0; i < words && xx < x1 - 4; i++) {
        const w = pick(CODE_T); c.fillStyle = rgba(t, rnd() < 0.25 ? 1 : rr(0.5, 0.8)); c.fillText(w, xx, y); xx += w.length * 2.15 + 2;
      }
      y += 4.6;
    }
  },
  kv(c, x0, x1, y0, y1, t) {
    let y = y1 - y0 > 18 ? header(c, x0, x1, y0, t) : y0 + 1;
    c.font = `500 3.6px ${FONT}`;
    while (y < y1 - 4) {
      c.fillStyle = rgba(t, 0.5); c.fillText(pick(KEYS), x0, y);
      const v = fmtNum(); c.fillStyle = rgba(t, 0.95); c.textAlign = 'right'; c.fillText(v, x1, y); c.textAlign = 'left';
      const bx = x0 + 14, bw = Math.max(0, x1 - x0 - 14 - v.length * 2.2 - 4);
      c.fillStyle = rgba(t, 0.15); c.fillRect(bx, y + 1.2, bw, 1.2);
      c.fillStyle = rgba(t, 0.7); c.fillRect(bx, y + 1.2, bw * rnd(), 1.2);
      y += 5.2;
    }
  },
  spark(c, x0, x1, y0, y1, t) {
    const y = header(c, x0, x1, y0, t), top = y + 1, bot = y1 - 2, n = 40;
    c.fillStyle = rgba(t, 0.18); c.fillRect(x0, bot, x1 - x0, 0.4); c.fillRect(x0, (top + bot) / 2, x1 - x0, 0.25);
    c.strokeStyle = rgba(t, 0.95); c.lineWidth = 0.55; c.beginPath();
    let v = rnd(), lx = 0, ly = 0;
    for (let i = 0; i <= n; i++) {
      v = clamp(v + gauss() * 0.22, 0, 1);
      lx = x0 + (x1 - x0) * i / n; ly = bot - v * (bot - top);
      i ? c.lineTo(lx, ly) : c.moveTo(lx, ly);
    }
    c.stroke(); c.fillStyle = '#fff'; c.fillRect(lx - 0.9, ly - 0.9, 1.8, 1.8);
  },
  bars(c, x0, x1, y0, y1, t) {
    const y = header(c, x0, x1, y0, t), n = 6 + (rnd() * 10 | 0), bh = (y1 - y - 1) / n;
    c.font = `500 3px ${FONT}`;
    for (let i = 0; i < n; i++) {
      const v = rr(0.1, 1), yy = y + i * bh;
      c.fillStyle = rgba(t, 0.35); c.fillText(String(i).padStart(2, '0'), x0, yy);
      c.fillStyle = rgba(t, v > 0.85 ? 1 : 0.65); c.fillRect(x0 + 7, yy + 0.4, (x1 - x0 - 7) * v, Math.max(0.8, bh - 1.2));
    }
  },
  prog(c, x0, x1, y0, y1, t) {
    let y = y1 - y0 > 18 ? header(c, x0, x1, y0, t) : y0 + 1;
    c.font = `500 3.4px ${FONT}`;
    while (y < y1 - 5) {
      const p = rnd();
      c.fillStyle = rgba(t, 0.55); c.fillText(pick(['read', 'build', 'review', 'qa', 'sync', 'diff']), x0, y);
      c.fillStyle = rgba(t, 0.9); c.textAlign = 'right'; c.fillText((p * 100 | 0) + '%', x1, y); c.textAlign = 'left';
      const bx = x0 + 15, bw = x1 - x0 - 26, segs = 12;
      for (let i = 0; i < segs; i++) { c.fillStyle = rgba(t, i / segs < p ? 0.85 : 0.14); c.fillRect(bx + i * bw / segs, y + 0.6, bw / segs - 0.6, 2); }
      y += 5.4;
    }
  },
  grid(c, x0, x1, y0, y1, t) {
    const y = y1 - y0 > 20 ? header(c, x0, x1, y0, t) : y0 + 1, p = rr(2.4, 3.2);
    for (let yy = y; yy < y1 - p + 0.5; yy += p) for (let xx = x0; xx < x1 - p + 0.5; xx += p) {
      const v = rnd();
      c.fillStyle = v > 0.93 ? 'rgba(240,166,198,.95)' : rgba(t, 0.08 + v * v * 0.8);
      c.fillRect(xx, yy, p - 0.6, p - 0.6);
    }
  },
  gauge(c, x0, x1, y0, y1, t) {
    const r = Math.min((y1 - y0) / 2 - 1.5, 9), gx = x0 + r + 1, gy = (y0 + y1) / 2, v = rnd();
    c.lineWidth = 1.2; c.strokeStyle = rgba(t, 0.15); c.beginPath(); c.arc(gx, gy, r, 0, TAU); c.stroke();
    c.strokeStyle = rgba(t, 0.95); c.beginPath(); c.arc(gx, gy, r, -Math.PI / 2, -Math.PI / 2 + TAU * v); c.stroke();
    c.font = `700 ${Math.max(3.2, r * 0.55)}px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = rgba(t, 1); c.fillText((v * 100 | 0) + '', gx, gy); c.textAlign = 'left'; c.textBaseline = 'top';
    if (x1 - (gx + r) > 20) BLOCKS.kv(c, gx + r + 4, x1, y0, y1, t);
  },
  wave(c, x0, x1, y0, y1, t) {
    const y = header(c, x0, x1, y0, t), mid = (y + y1) / 2, amp = (y1 - y) * 0.38, f1 = rr(0.15, 0.4), f2 = rr(0.5, 1.2), ph = rnd() * 6;
    [[0.95, 1], [0.4, -0.6]].forEach(([a, k]) => {
      c.strokeStyle = rgba(t, a); c.lineWidth = 0.5; c.beginPath();
      for (let xx = x0; xx <= x1; xx += 0.8) { const yy = mid + amp * k * (Math.sin(xx * f1 + ph) * 0.7 + Math.sin(xx * f2) * 0.3); xx === x0 ? c.moveTo(xx, yy) : c.lineTo(xx, yy); }
      c.stroke();
    });
  },
  para(c, x0, x1, y0, y1, t) { glyphStrips(x0, x1, y0, y1, rr(2.6, 3.4), { tint: t, ragged: true, th: 1.3 }, c); },
  cols(c, x0, x1, y0, y1, t) { glyphStrips(x0, x1, y0, y1, rr(3.6, 4.6), { tint: t, colGap: true, th: 1.5 }, c); },
  barcode(c, x0, x1, y0, y1, t) { glyphStrips(x0, x1, y0, y1, rr(3.2, 4.2), { tint: t, solid: true, th: 1.8 }, c); },
  matrix(c, x0, x1, y0, y1, t) {
    const p = rr(2.1, 2.6), dens = rr(0.35, 0.65);
    for (let yy = y0; yy < y1 - 1; yy += p) for (let xx = x0; xx < x1; xx += p)
      if (rnd() < dens) { c.fillStyle = rgba(t, rr(0.5, 1)); c.fillRect(xx, yy, 1.4, 1.4); }
  },
};
const BLOCK_W = [['code', 16], ['kv', 11], ['spark', 9], ['bars', 8], ['prog', 7], ['grid', 7], ['gauge', 3], ['wave', 4],
  ['para', 12], ['cols', 7], ['barcode', 6], ['matrix', 8]];
const NEEDS_H = { code: 18, spark: 18, bars: 20, wave: 18, gauge: 16 };
function pickBlock(h) {
  for (let tries = 0; tries < 8; tries++) {
    let r = rnd() * 100, name = 'para';
    for (const [n, w] of BLOCK_W) { r -= w; if (r <= 0) { name = n; break; } }
    if (!NEEDS_H[name] || h >= NEEDS_H[name]) return name;
  }
  return pick(['para', 'kv', 'matrix', 'barcode']);
}
function renderSlot(s) {
  const band = RO - R, h = s.hpx;
  const c = document.createElement('canvas');
  c.width = Math.ceil(band * RING_SC); c.height = Math.ceil((h + 2) * RING_SC);
  const x = c.getContext('2d'); x.scale(RING_SC, RING_SC); x.textBaseline = 'top';
  const RB = rimW(), dz0 = RB + 6, dz1 = band * 0.72, oz0 = band * 0.78, oz1 = band - RB - 5;
  const split = rnd() < 0.45 && dz1 - dz0 > 60;
  const blocks = [];
  if (split) { const m = dz0 + (dz1 - dz0) * rr(0.42, 0.6); blocks.push([dz0, m], [m + rr(4, 8), dz1]); }
  else blocks.push([dz0, dz1 - rr(0, 18)]);
  for (const [b0, b1] of blocks) {
    const tint = pick(TINTS), y0 = 1 + rr(0, 2), y1 = h + 1 - rr(0, 2);
    x.save(); x.beginPath(); x.rect(b0, y0 - 0.5, b1 - b0, y1 - y0 + 1); x.clip();
    BLOCKS[pickBlock(y1 - y0)](x, b0, b1, y0, y1, tint);
    x.restore();
  }
  // outer index column: tiny ids + tick groups
  const pitch = rr(8, 12);
  x.font = `600 3.1px ${FONT}`;
  for (let yy = rr(1, pitch); yy < h - 2; yy += pitch) {
    if (rnd() < 0.15) continue;
    let xx = oz0 + rr(0, 3);
    if (rnd() < 0.45) { x.fillStyle = `rgba(225,228,236,${rr(0.55, 0.95)})`; x.fillText(String((rnd() * 999) | 0).padStart(3, '0'), xx, yy - 1); xx += 9; }
    const n = 1 + (rnd() * 3 | 0);
    for (let i = 0; i < n && xx < oz1; i++) { x.fillStyle = `rgba(225,228,236,${rr(0.5, 0.95)})`; x.fillRect(xx, yy, rr(1.2, 2.4), 1.2); xx += rr(2.4, 3.6); }
  }
  if (rnd() < 0.45) {
    x.fillStyle = 'rgba(220,224,232,.7)';
    for (let xx = dz0; xx < oz1; xx += rr(2.4, 4.5)) if (rnd() < 0.8) x.fillRect(xx, h + 0.4, 1.1, 1.1);
  }
  s.c = c;
}
function rimW() { return Math.max(3, (RO - R) * 0.065 * C.rimWidth); }
function drawRing(dt) {
  const band = RO - R;
  S.globalCompositeOperation = 'source-over';
  S.save(); S.translate(cx, cy);
  S.beginPath(); S.arc(0, 0, RO, 0, TAU); S.arc(0, 0, R, 0, TAU, true);
  S.fillStyle = '#040506'; S.fill('evenodd');
  let regen = agtQuality.cards;
  agtBeginCardFrame();
  for (const s of slots) {
    const A = s.a + ringRot;
    if (s.flash > 0) s.flash = Math.max(0, s.flash - dt * 2.2);
    const mid = R + band * 0.42;
    const sp = toScreen(cx + Math.cos(A) * mid, cy + Math.sin(A) * mid);
    if (sp.x < -140 || sp.x > W + 140 || sp.y < -140 || sp.y > H + 140) continue;
    if ((!s.c || s.dirty || s.cacheDpr<agtDesiredCardDpr()) && regen > 0) { renderSlot(s); s.dirty=false; regen--; }
    if (!s.c) continue;
    agtTouchCard(s);
    S.save(); S.rotate(A);
    const hh = s.hpx + 2;
    S.drawImage(s.c,0,0,s.sourceWidth,s.sourceHeight,R,-hh/2,band,hh);
    if (s.flash > 0.02) { S.globalCompositeOperation = 'lighter'; S.globalAlpha = s.flash; S.drawImage(s.c,0,0,s.sourceWidth,s.sourceHeight,R,-hh/2,band,hh); S.globalAlpha = 1; S.globalCompositeOperation = 'source-over'; }
    S.restore();
  }
  agtTrimCardCache();
  // rulers & rim bands (all rotate with the ring)
  const tick = (step, fn) => {
    const n0 = Math.floor((-thV - 0.05 - ringRot) / step), n1 = Math.ceil((thV + 0.05 - ringRot) / step);
    for (let n = n0; n <= n1; n++) { const a = n * step + ringRot; fn(Math.cos(a), Math.sin(a), n); }
  };
  const RB = rimW();
  // inner + outer rim bands: dense white hairlines that give the edge its thickness
  S.beginPath();
  tick(0.14 / C.rimDensity * Math.PI / 180, (ca, sa, n) => {
    const m = ((n % 6) + 6) % 6;
    const li = m === 0 ? RB : RB * (0.5 + 0.35 * hash(n));
    const lo = m === 0 ? RB : RB * (0.5 + 0.35 * hash(n + 77));
    S.moveTo(ca * (R + 1.5), sa * (R + 1.5)); S.lineTo(ca * (R + 1.5 + li), sa * (R + 1.5 + li));
    S.moveTo(ca * (RO - 1.5), sa * (RO - 1.5)); S.lineTo(ca * (RO - 1.5 - lo), sa * (RO - 1.5 - lo));
  });
  S.globalCompositeOperation = 'lighter';
  S.strokeStyle = `rgba(232,235,242,${Math.min(1, 0.035 * C.rimBright * C.rimBright)})`; S.lineWidth = 1.2 + 2.4 * C.rimBright; S.stroke();   // glow grows with brightness
  S.strokeStyle = `rgba(232,235,242,${Math.min(1, 0.08 * C.rimBright)})`; S.lineWidth = 1.4; S.stroke();
  S.globalCompositeOperation = 'source-over'; S.strokeStyle = `rgba(240,242,248,${Math.min(1, 0.88 * C.rimBright)})`; S.lineWidth = 0.55; S.stroke();
  // rims
  const arc = (r, lw, a) => { S.strokeStyle = `rgba(232,235,242,${a})`; S.lineWidth = lw; S.beginPath(); S.arc(0, 0, r, -thV, thV); S.stroke(); };
  arc(R, 1.5, 1); arc(R + RB + 3, 0.6, 0.6); arc(RO - RB - 3, 0.6, 0.55);
  S.globalCompositeOperation = 'lighter'; arc(RO, 3.5, 0.1); S.globalCompositeOperation = 'source-over';
  arc(RO, 1.3, 0.95);
  S.beginPath();
  tick(1 * Math.PI / 180, (ca, sa) => { S.moveTo(ca * (R - 2), sa * (R - 2)); S.lineTo(ca * (R - 5), sa * (R - 5)); });
  tick(0.25 * Math.PI / 180, (ca, sa, n) => {
    const m = ((n % 20) + 20) % 20, L = m === 0 ? 9 : m % 5 === 0 ? 5 : 2.5;
    S.moveTo(ca * (RO + 2), sa * (RO + 2)); S.lineTo(ca * (RO + 2 + L), sa * (RO + 2 + L));
  });
  S.strokeStyle = 'rgba(230,233,240,.5)'; S.lineWidth = 0.6; S.stroke();
  S.restore();
}

/* ---------- frame ---------- */
function drawStage(dt) {
  updateBeat(dt); updateCam(dt);
  withRing(outerIdx(), () => updateOuter(dt));
  if (rnd() < dt * C.cometTrickle) spawnComet();
  webRot += dt * (0.03 + env * 0.12) * C.webSpin;
  withRingEach(() => updateRing(dt));
  for (let k = 0; k < 3; k++) layerEnv[k] *= Math.exp(-dt * 2.2);

  // background
  S.setTransform(DPR, 0, 0, DPR, 0, 0);
  S.globalCompositeOperation = 'source-over'; S.globalAlpha = 1;
  S.fillStyle = '#08090b'; S.fillRect(0, 0, W, H);

  // glow buffer (low-res, blurred later)
  const G = glowC.x;
  G.setTransform(1, 0, 0, 1, 0, 0); G.clearRect(0, 0, glowC.width, glowC.height);
  camT(G, 1 / GS); G.globalCompositeOperation = 'lighter';

  camTk(S, DPR, 1 - 0.1 * C.parallax);   // the web sits a little further back

  // 共享光场：构建与绘制使用同一套几何（withRing(0) 的 R = 全幅半径）
  withRing(0, () => {
    R = weaveR;
    const ws = 2 * R + 4;
    S.save(); S.translate(cx, cy); S.rotate(webRot);
    drawArtField();
    drawArtRunners(dt);
    S.restore();
  });
  camT(S, DPR);
  // ring occlusion: 织场向每条环带内侧渐暗（用最外环内径），分离平面
  if (C.ringShadow > 0 && RINGS.length) {
    const oR = RINGS[outerIdx()].R;
    const sg = S.createRadialGradient(cx, cy, Math.max(40, oR - 110), cx, cy, oR);
    sg.addColorStop(0, 'rgba(4,5,6,0)'); sg.addColorStop(1, `rgba(4,5,6,${Math.min(1, 0.8 * C.ringShadow)})`);
    S.globalCompositeOperation = 'source-over'; S.globalAlpha = 1; S.fillStyle = sg;
    S.beginPath(); S.arc(cx, cy, oR, 0, TAU); S.arc(cx, cy, Math.max(40, oR - 110), 0, TAU, true); S.fill('evenodd');
  }

  // comets
  S.save(); S.translate(cx, cy); S.globalCompositeOperation = 'lighter'; S.lineCap = 'round';
  G.save(); G.translate(cx, cy);
  for (let i = comets.length - 1; i >= 0; i--) {
    const c = comets[i];
    c.life += dt;
    const p = easeIO(Math.min(1, c.life / c.dur));
    const head = Math.min(1, p * (1 + c.win)), tail = Math.max(0, p * (1 + c.win) - c.win);
    const fade = c.life > c.dur ? Math.max(0, 1 - (c.life - c.dur) / 0.25) : 1;
    if (fade <= 0) { comets.splice(i, 1); continue; }
    const ri = c.ringId != null ? RINGS.findIndex(r => r.id === c.ringId) : c.ring;
    if (ri < 0 || !RINGS[ri]) { c.life = Math.max(c.life, c.dur + 0.05); }   // 环已移除：不跟随被顶替的环，快速退场
    const followRot = RINGS[ri] ? RINGS[ri].ringRot : ringRot;
    const cr = C.cometFollow ? followRot - c.rot0 : 0;
    if (head >= 1 && !c.hit && RINGS[ri]) { c.hit = true; const pe = cpt(c.lines[c.lines.length >> 1], 1); flashSlotAt(ri, Math.atan2(pe.y, pe.x) + cr); }
    if(c.identity)continue; // 身份束在信息层的环带之后绘制，不能被中间环遮住。
    S.save(); S.rotate(cr); G.save(); G.rotate(cr);
    const col = c.identity || (c.tint ? '200,190,250' : '255,255,255');
    S.strokeStyle = `rgba(${col},${Math.min(1, 0.5 * fade * C.cometBright)})`; S.lineWidth = 1;
    strokeComet(S, c, tail, head, 18);
    const hs = head - (head - tail) * 0.35;
    S.strokeStyle = `rgba(${col},${Math.min(1, fade * C.cometBright)})`; S.lineWidth = 1.7;
    strokeComet(S, c, hs, head, 8);
    if (c.glow && C.cometGlow > 0) { G.strokeStyle = `rgba(${col},${Math.min(1, 0.5 * fade * C.cometGlow)})`; G.lineWidth = 2.8; strokeComet(G, c, hs, head, 6); }
    G.restore(); S.restore();
  }
  G.restore();
  S.restore();

  // outer wedges（锚定最外环）
  withRing(outerIdx(), () => {
  S.globalCompositeOperation = 'lighter';
  S.drawImage(laneC, 0, 0, W, H);
  // far outer layers 鈫?half-res buffer, composited blurred (depth of field)
  const F = farC.x;
  F.setTransform(1, 0, 0, 1, 0, 0); F.globalAlpha = 1; F.globalCompositeOperation = 'source-over'; F.clearRect(0, 0, farC.width, farC.height);
  camT(F, FS); F.globalCompositeOperation = 'lighter';
  S = F; drawOuterFar(); S = S_MAIN;
  S.save(); S.setTransform(DPR, 0, 0, DPR, 0, 0); S.globalCompositeOperation = 'lighter';
  if (HAS_FILTER && C.depthBlur > 0) S.filter = `blur(${C.depthBlur}px)`;
  S.globalAlpha = Math.min(1, C.depthDim); S.drawImage(farC, 0, 0, W, H);
  S.restore();
  // atmosphere: faint scattered light just beyond the ring
  if (C.atmos > 0) {
    const ag = S.createRadialGradient(cx, cy, RO, cx, cy, RO + (RMAX - RO) * 0.7);
    ag.addColorStop(0, `rgba(190,180,240,${Math.min(1, 0.07 * C.atmos)})`); ag.addColorStop(0.4, `rgba(150,145,210,${Math.min(1, 0.028 * C.atmos)})`); ag.addColorStop(1, 'rgba(0,0,0,0)');
    S.globalAlpha = 1; S.fillStyle = ag; S.beginPath(); S.arc(cx, cy, RMAX, 0, TAU); S.arc(cx, cy, RO, 0, TAU, true); S.fill('evenodd');
  }
  drawOuterNear();
  });

  // Sharp ring/cards are painted after the effects composite.

  // composite soft glow
  S.setTransform(DPR, 0, 0, DPR, 0, 0);
  S.globalCompositeOperation = 'lighter';
  compositeGlow();
  S.globalAlpha = 1; S.globalCompositeOperation = 'source-over';

  drawBokeh(dt);
  if (C.vignette > 0) {
    S.setTransform(DPR, 0, 0, DPR, 0, 0);
    const vg = S.createRadialGradient(W * 0.45, H * 0.5, Math.min(W, H) * 0.35, W * 0.45, H * 0.5, Math.hypot(W, H) * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${Math.min(1, 0.75 * C.vignette)})`);
    S.fillStyle = vg; S.fillRect(0, 0, W, H);
  }

  // DOM callout and sharp connector are painted on the information layer.
}

/* ---------- callout box with leader line (follows the camera) ---------- */
const CHECKS = [['STABILITY CHECK', 'CFL = |u| Δt / Δx'], ['MASS CONSERVATION', 'Σ ρ dV = const'], ['RESIDUAL NORM', 'r = ‖b − A·u‖₂'],
  ['BOUNDARY', 'u · n = 0  on ∂Ω'], ['PROJECTION', '∇²p = ∇ · u* / Δt']];
let chkI = 0;
const chkEl = document.getElementById('chk');
function drawCallout() {
  // 执行引线浮标：数据来自双路监管同一份选择（window.haloSupervision），身份色贯穿锚点/引线/边框
  if (window.haloCallouts === false) return;
  const chans = window.haloSupervision || [];
  if (!window.__haloCalloutEls) {
    const wrap = document.getElementById('stageWrap');
    window.__haloCalloutEls = wrap ? [0, 1].map(i => {
      const el = document.createElement('div'); el.className = 'halo-callout hidden'; el.id = 'haloCallout' + i;
      wrap.appendChild(el); return el;
    }) : [];
  }
  window.__haloCalloutEls.forEach(el => el.classList.add('hidden'));
  if (!chans.length) return;
  const ACOL = { codex: '#dfe6ee', dsh: '#6ec8e8', zcode: '#e6a842', workbuddy: '#98e0cf' };
  const used = [];
  let ci = 0;
  for (const ch of chans) {
    if (ci >= 2) break;
    const ses = ch.session; if (!ses) continue;
    const idx = ringByAgent[ch.agent]; if (idx == null || !RINGS[idx]) continue;
    const st = RINGS[idx];
    const tgt = cardTargetFor(ch.agent, ses.key) || { x: cx + Math.cos(0.02) * (st.R + (st.RO - st.R) / 2), y: cy + Math.sin(0.02) * (st.R + (st.RO - st.R) / 2) };
    const anchor = toScreen(tgt.x, tgt.y);
    if (anchor.x < -30 || anchor.x > W + 30 || anchor.y < -30 || anchor.y > H + 30) continue;
    const col = ACOL[ch.agent] || '#dfe6ee';
    let bx = Math.min(W - 226, Math.max(8, anchor.x + 44)), by = anchor.y - 62 + ci * 78;
    for (const u of used) if (Math.abs(u.by - by) < 70 && Math.abs(u.bx - bx) < 210) by = u.by + 78;
    by = Math.max(52, Math.min(H - 156, by));   // 避开顶栏与底栏
    used.push({ bx, by });
    const el = window.__haloCalloutEls[ci];
    const stTxt = ({ thinking: '思考中', streaming: '输出中', tool: '工具运行', waiting: '等待', error: '出错', idle: '空闲' })[ses.state] ?? ses.state;
    const sig = JSON.stringify([ses.key,ses.state,ses.tokens?.output ?? null,ses.model || '']);
    el.classList.remove('hidden');
    el.style.borderColor = col;
    if (el.__sig !== sig) {
      el.__sig = sig;
      el.innerHTML = `<div class="hc-l1" style="color:${col}">${haloAgentLabel[ch.agent] ?? ch.agent} · ${escapeHTML(ses.model || '未提供')}</div>`
        + `<div class="hc-l2">${stTxt} · ${typeof ses.tokens?.output === 'number' && Number.isFinite(ses.tokens.output) ? '累计输出 ' + compactValue(ses.tokens.output) : '输出 未提供'}</div>`;
    }
    el.style.transform = `translate(${bx}px,${by}px)`;
    S.strokeStyle = col; S.globalAlpha = 0.55; S.lineWidth = 0.8;
    S.beginPath(); S.moveTo(anchor.x, anchor.y); S.lineTo(bx, by + 14); S.stroke();
    S.fillStyle = col; S.fillRect(anchor.x - 1.5, anchor.y - 1.5, 3, 3); S.globalAlpha = 1;
    ci++;
  }
}



const AVAILABLE_SKILLS=[]; // Reference export: local skill inventory omitted.
/* Local telemetry UI. Labels are Chinese; model/tool identifiers remain original. */
const byId=id=>document.getElementById(id);
const escapeHTML=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty=n=>typeof n==='number'&&Number.isFinite(n)?n.toLocaleString('zh-CN'):'未提供';
const compactValue=n=>n>=1e8?(n/1e8).toFixed(2)+'亿':n>=1e4?(n/1e4).toFixed(1)+'万':pretty(n);
const isActive=s=>s?.status==='running'||s?.status==='active'||s?.status==='in_progress';
const statusText={running:'执行中',active:'活动中',idle:'空闲',unknown:'待确认',offline:'未打开',completed:'完成',failed:'失败',pending:'等待中',in_progress:'执行中'};
const toolLabel=name=>({exec:'工具编排',exec_command:'终端执行',CommandExecution:'终端执行',McpToolCall:'外部工具',mcp_tool:'外部工具',web_search:'网页检索',apply_patch:'修改文件',wait:'等待结果',write_stdin:'进程交互'})[name]||String(name||'').replace(/^functions\./,'');
const agtState={snapshot:null,filter:'all',selected:null,activeOnly:false,includeSubagents:false,paused:false,failed:false,feedSignature:'',wallpaperPaused:false,fps:60,focusMode:false};
let agtSettings={name:'Personal Halo',quiet:false,panelsCollapsed:false,quality:'balanced',panelView:'monitor'};
  try{const stored=JSON.parse(localStorage.getItem('personal-halo.screen.v1')||'null');if(stored)Object.assign(agtSettings,stored);}catch{}
// Replace the old blanket downsampling profile once; later choices stay user-controlled.
if(agtSettings.resourceProfile!==2){agtSettings.quality='balanced';agtSettings.resourceProfile=2;saveScreenSettings();}
if(!['balanced','high','low'].includes(agtSettings.quality))agtSettings.quality='balanced';
if(!['monitor','original'].includes(agtSettings.panelView))agtSettings.panelView='monitor';
let T=0;
function resizePanels(){}
function agentsTick(){}
function sourceSessions(){return(agtState.snapshot?.sessions||[]).filter(s=>agtState.filter==='all'||s.source===agtState.filter);}
function selectedSessions(){return sourceSessions().filter(s=>agtState.includeSubagents||!s.isSubagent).sort((a,b)=>Number(isActive(b))-Number(isActive(a))||Number(b.lastAt||0)-Number(a.lastAt||0));}
function focusedSession(){return selectedSessions().find(s=>s.id===agtState.selected)||null;}
function occupancy(s){return s?.contextWindow?Math.max(0,Math.min(1,s.contextTokens/s.contextWindow)):0;}
function saveScreenSettings(){try{localStorage.setItem('personal-halo.screen.v1',JSON.stringify(agtSettings));}catch{}}
const agtMarkupCache=new WeakMap();
function agtSetMarkup(element,markup){if(agtMarkupCache.get(element)!==markup){element.innerHTML=markup;agtMarkupCache.set(element,markup);}}
function applyScreenSettings(){
  document.title=agtSettings.name;
  byId('stageWrap').classList.toggle('quiet',!!agtSettings.quiet);
  document.body.classList.toggle('panels-collapsed',!!agtSettings.panelsCollapsed);
  byId('togglePanels').textContent=agtSettings.panelsCollapsed?'展开信息栏 ▴':'收起信息栏 ▾';
  byId('togglePanels').setAttribute('aria-expanded',String(!agtSettings.panelsCollapsed));
  const safeBottom=wallpaperHost()?Math.max(48,Math.min(120,(screen.height-screen.availHeight)||48)):0;
  document.documentElement.style.setProperty('--safe-bottom',safeBottom+'px');
  const original=agtSettings.panelView==='original';
  byId('sourceCanvasCaption').textContent=original?'原作视觉演示，不代表任务数据':'来源连接 · 当前任务上下文';
  byId('sourceCanvasCaption').title=original?'原作效果为视觉演示，不代表任务数据':'来源在线状态与当前任务的实际上下文占用';
  byId('sourcePanelHeading').textContent=original?'原版场动效':'来源与上下文';
  byId('matrixPanelHeading').textContent=original?'原版扫描动效':'任务用量对比';
  const matrixText=original?'原作视觉演示 · ':'输入 / 输出 / 缓存以当前前六任务最大值作相对比较 · ';
  byId('matrixCaption').innerHTML=escapeHTML(original?matrixText:'相对用量对比 · ')+'<a href="https://github.com/Ryder191/haloflux" target="_blank" rel="noreferrer" title="原作 HALOFLUX · Ryder191">HALOFLUX ↗</a>';
  byId('matrixCaption').title=original?'原作效果为视觉演示，不代表任务数据':matrixText+'上下文按各任务的窗口占比显示';
  if(typeof window.agtSetQuality==='function')window.agtSetQuality(agtSettings.quality);
  if(typeof agtMarkPanelsDirty==='function')agtMarkPanelsDirty();
}
function toast(message){byId('toast').textContent=message;byId('toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>byId('toast').classList.remove('show'),2000);}
function updateCallout(){const s=focusedSession();byId('chkK').textContent=s?`${s.source==='codex'?'Codex':'DSH'} · ${s.model}`:'真实任务关联';byId('chkV').textContent=s?`${statusText[s.status]} · 输出 ${compactValue(s.outputTokens)}`:'等待本机任务';}
function renderWorkspace(){
  const s=focusedSession();
  const rows=s?[
    ...(s.isSubagent?[['归属',s.parentTitle||'协作子任务','']]:[]),
    ['状态',(statusText[s.status]||'待确认')+' · '+(s.source==='codex'?'Codex':'DSH'),isActive(s)?'status-running':''],
    ['模型',s.model||'未提供',''],[isActive(s)?'当前工具':'最近工具',s.lastTool?toolLabel(s.lastTool):'暂无记录',''],
    ['上下文',s.contextWindow?(occupancy(s)*100).toFixed(1)+'%':'未提供','']
  ]:[['任务','等待软件启动',''],['来源','自动接入 Codex / DSH',''],['状态','本机监听中','status-running']];
  agtSetMarkup(byId('code'),(s?`<div class="focus-task-title" title="${escapeHTML(s.title)}">${escapeHTML(s.title||'未命名任务')}</div>`:'')+rows.map(r=>`<div class="code-line"><span class="key">${r[0]}</span><span class="value ${r[2]}" title="${escapeHTML(r[1])}">${escapeHTML(r[1])}</span></div>`).join(''));
}
function renderFeed(){
  const events=(agtState.snapshot?.events||[]).filter(e=>agtState.filter==='all'||e.source===agtState.filter).slice(0,5).reverse();
  const sig=JSON.stringify(events);if(sig===agtState.feedSignature)return;agtState.feedSignature=sig;
  byId('feed').innerHTML=events.length?events.map(e=>`<div title="${escapeHTML(e.message)} · ${statusText[e.status]||'已记录'}"><span class="time">${new Date(e.at*1000).toLocaleTimeString('zh-CN',{hour12:false})}</span><span class="vb ${e.status==='failed'?'build':e.source==='dsh'?'build':'read'}">${e.source==='codex'?'Codex':'DSH'}</span>${escapeHTML(toolLabel(e.message))}${e.status==='failed'?' · 失败':''}</div>`).join(''):'<div><span class="vb read">监听</span>等待真实工具调用记录</div>';
}
function renderRoutes(){
  const sources=agtState.snapshot?.sources||[];
  byId('routes').innerHTML='<span class="h">来源</span><span class="h">连接</span><span class="h">执行中</span><span class="h">主任务 / 协作</span>'+sources.map(s=>`<span class="nm">${s.id==='codex'?'Codex':'DSH'}</span><span><span class="chip ${s.online?'on':''}">${s.online?'在线':'未打开'}</span></span><span><span class="chip ${s.running?'pk':''}">${s.running}</span></span><span><span class="chip ${s.online?'done':''}">${s.threads??s.sessions} / ${s.subagents||0}</span></span>`).join('')+`<div class="bridge-text">${agtState.failed?'连接中断，正在重试':agtState.snapshot?'本机同步 · '+new Date(agtState.snapshot.at*1000).toLocaleTimeString('zh-CN',{hour12:false}):'正在发现来源'}</div>`;
  byId('sourceNotes').textContent=sources.map(s=>s.note).filter(Boolean).join(' / ')||'自动接入与退出';
}
function renderAgents(){
  const sessions=selectedSessions();byId('dispatchHeading').textContent=(agtState.includeSubagents?'任务编队 · ':'主任务 · ')+sessions.length;
  const priority=s=>s.source+':'+s.id===agtState.selected?2:isActive(s)?1:0;
  const visible=[...sessions].sort((a,b)=>priority(b)-priority(a)).slice(0,5);
  agtSetMarkup(byId('agents'),visible.map(s=>{const key=s.source+':'+s.id,title=s.title||'未命名任务',index=sessions.indexOf(s)+1;return`<button type="button" class="ag ${isActive(s)?'live':''} ${key===agtState.selected?'selected':''}" data-session="${escapeHTML(key)}" title="${escapeHTML((s.source==='codex'?'Codex':'DSH')+' · '+title+' · '+(statusText[s.status]||'待确认'))}"><span class="id">${String(index).padStart(2,'0')}</span><span class="ag-name">${escapeHTML(title)}</span><span class="st">${statusText[s.status]||'待确认'}</span></button>`;}).join('')||'<span class="empty-task">暂无在线任务</span>');
  const children=sourceSessions().filter(s=>s.isSubagent).length;
  byId('dispatchCaption').textContent=`显示 ${visible.length} / ${sessions.length}`+(!agtState.includeSubagents&&children?` · ${children} 个协作子任务可在全部任务中查看`:' · 点击查看任务');
}
function requestRateDisplay(info){
  const valid=info&&typeof info.value==='number'&&Number.isFinite(info.value)&&info.value>0;
  const age=info?.sampleAt?Math.max(0,Date.now()/1000-info.sampleAt):null;
  const ageText=age===null?'':age<60?Math.floor(age)+'秒前':age<3600?Math.floor(age/60)+'分钟前':Math.floor(age/3600)+'小时前';
  const text=valid?(info.kind==='estimated_request_average'?'≈ ':'')+info.value.toFixed(1)+' tok/s':info?.status==='idle'?'空闲':info?.status==='waiting'?'等待采样':'暂不可用';
  const details=[info?.reason,info?.source?'来源 '+info.source:'',valid&&info?.windowMs?'窗口 '+(info.windowMs/1000).toFixed(1)+' 秒':'',info?.includesFirstTokenWait===true?'估算包含首字等待':'',ageText].filter(Boolean).join(' · ');
  return{text,meta:valid?ageText:'',title:details||'请求完成并写入用量后才能计算；当前没有可用样本'};
}
function renderRequestRate(info){
  const display=requestRateDisplay(info),value=byId('k4'),meta=byId('rateMeta');
  if(value.textContent!==display.text)value.textContent=display.text;
  if(value.title!==display.title)value.title=display.title;
  if(meta.textContent!==display.meta)meta.textContent=display.meta;
  if(byId('rateLabel').textContent!=='最近请求均速')byId('rateLabel').textContent='最近请求均速';
}
function renderTaskDialog(){
  const list=selectedSessions().filter(s=>!agtState.activeOnly||isActive(s));
  const children=sourceSessions().filter(s=>s.isSubagent).length;
  byId('taskCount').textContent=`${list.length} 个${agtState.includeSubagents?'任务':'主任务'}`+(!agtState.includeSubagents&&children?` · 另有 ${children} 个协作子任务`:'');
  byId('taskList').innerHTML=list.map(s=>{const key=s.source+':'+s.id;return`<button class="task-card ${s.source} ${key===agtState.selected?'selected':''}" data-session="${escapeHTML(key)}"><span class="task-top"><span>${s.source==='codex'?'Codex':'DSH'} · ${s.isSubagent?'协作子任务':'主任务'} · ${escapeHTML(s.id.slice(-6))}</span><span class="state-tag">${statusText[s.status]}</span></span><div class="task-title">${escapeHTML(s.title)}</div><div class="task-meta">${escapeHTML(s.model)} · 输出 ${pretty(s.outputTokens)}${s.isSubagent&&s.parentTitle?' · 归属 '+escapeHTML(s.parentTitle):''}</div></button>`;}).join('')||'<div class="empty-task">当前筛选下暂无任务</div>';
  const s=focusedSession();byId('focusDetails').innerHTML=s?`<div class="detail-title">${escapeHTML(s.title)}</div><div class="detail-data"><div><span>模型：</span>${escapeHTML(s.model)}</div><div><span>输入：</span>${pretty(s.inputTokens)}</div><div><span>输出：</span>${pretty(s.outputTokens)}</div><div><span>缓存：</span>${pretty(s.cachedTokens)}</div><div><span>上下文：</span>${s.contextWindow?(occupancy(s)*100).toFixed(1)+'%':'未提供'}</div><div><span>状态：</span>${statusText[s.status]}</div></div><div class="muted">${escapeHTML(s.cwd)}</div>`:'';
}
function renderSnapshot(){
  const snap=agtState.snapshot;if(!snap)return;const sessions=selectedSessions();
  if(!sessions.some(s=>s.source+':'+s.id===agtState.selected))agtState.selected=sessions.length?sessions[0].source+':'+sessions[0].id:null;
  const total=snap.totals||{};[total.online,total.running,total.threads??total.sessions,compactValue(total.outputTokens)].forEach((v,i)=>byId('k'+i).textContent=v??0);byId('k2').title=`${total.threads??total.sessions??0} 个主任务 · ${total.subagents||0} 个协作子任务`;renderRequestRate(total.outputRateInfo);
  const focus=focusedSession();byId('stBig').textContent=focus?focus.title:'等待 Codex / DSH 启动';
  const topology=snap.topology||{nodes:[],edges:[]};
  byId('stageSub').textContent=agtState.failed?'连接中断，保留最后记录':`真实节点 ${topology.nodes.length} · 已记录关系 ${topology.edges.length} · ${total.running||0} 个任务执行中`;
  renderWorkspace();renderFeed();renderRoutes();renderAgents();updateCallout();syncTaskScene();
  if(typeof agtMarkPanelsDirty==='function')agtMarkPanelsDirty();
  if(byId('tasksDialog').open)renderTaskDialog();
}
const agtPoll={timer:null,inflight:false,wake:false,etag:'',signature:'',failures:0,checkedAt:0,controller:null,abortedForWake:false};
function agtRefreshConnection(at){
  if(Number.isFinite(at)&&at>0)agtPoll.checkedAt=at;
  const previous=agtState.failed;
  agtState.failed=!agtPoll.checkedAt||Date.now()/1000-agtPoll.checkedAt>5;
  const el=byId('connection');if(!el)return;const label=agtState.failed?'更新停滞':'实时连接';
  el.classList.toggle('stale',agtState.failed);
  agtSetMarkup(el,'<i></i>'+label);
  el.title=agtPoll.checkedAt?'最近采集 '+new Date(agtPoll.checkedAt*1000).toLocaleTimeString('zh-CN',{hour12:false}):'等待采集器';
  return previous!==agtState.failed;
}
function agtWakeData(){
  clearTimeout(agtPoll.timer);agtPoll.wake=true;
  if(agtPoll.inflight){agtPoll.abortedForWake=true;agtPoll.controller?.abort();}
  else pollAGT();
}
async function pollAGT(){
  if(agtPoll.inflight){agtPoll.wake=true;return;}
  clearTimeout(agtPoll.timer);agtPoll.inflight=true;agtPoll.wake=false;
  const began=performance.now(),controller=new AbortController();
  agtPoll.controller=controller;agtPoll.abortedForWake=false;
  const timeout=setTimeout(()=>controller.abort(),3500);
  try{
    const host=location.protocol==='file:'?window.agtWallpaperHost:null,headers=host?{'X-AGT-Token':host.token}:{};
    if(agtPoll.etag&&agtState.snapshot)headers['If-None-Match']=agtPoll.etag;
    const response=await fetch(host?host.api+'/api/state':'/api/state',{cache:'no-store',signal:controller.signal,headers});
    if(response.status===304){
      agtPoll.failures=0;
      const changed=agtRefreshConnection(Number(response.headers.get('X-AGT-Checked-At')));
      renderRequestRate(agtState.snapshot?.totals?.outputRateInfo);
      if(changed)renderSnapshot();
      return;
    }
    if(!response.ok)throw Error('采集器未连接');
    const snap=await response.json();
    if(snap.discovering){agtPoll.failures=0;byId('connection').classList.remove('stale');agtSetMarkup(byId('connection'),'<i></i>识别来源');return;}
    agtPoll.failures=0;agtPoll.etag=response.headers.get('ETag')||'';agtState.snapshot=snap;
    const connectionChanged=agtRefreshConnection(Number(response.headers.get('X-AGT-Checked-At'))||Number(snap.at));
    const signature=JSON.stringify([snap.sources,snap.sessions,snap.events,snap.totals]);
    if(signature!==agtPoll.signature||connectionChanged){agtPoll.signature=signature;renderSnapshot();}
    else renderRequestRate(snap.totals?.outputRateInfo);
  }catch{
    if(agtPoll.abortedForWake)return;
    agtPoll.failures++;agtState.failed=true;byId('connection').classList.add('stale');
    agtSetMarkup(byId('connection'),'<i></i>正在重连');
    byId('stageSub').textContent='采集器未连接，正在重试';renderRoutes();
  }finally{
    clearTimeout(timeout);agtPoll.controller=null;agtPoll.abortedForWake=false;agtPoll.inflight=false;
    const hidden=document.hidden||agtState.wallpaperPaused;
    const interval=agtPoll.failures?Math.min(15000,1000*2**Math.min(4,agtPoll.failures-1)):hidden?10000:750;
    agtPoll.timer=setTimeout(pollAGT,agtPoll.wake?0:Math.max(50,interval-(performance.now()-began)));
  }
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&typeof haloWake==='function')haloWake();});
function selectTask(key){agtState.selected=key;renderSnapshot();}
function wallpaperHost(){return !!window.agtWallpaperHost;}
function syncScreenControls(){
  const fullscreen=!!document.fullscreenElement;
  byId('motionButton').textContent=agtState.paused?'继续':'暂停';
  byId('motionButton').setAttribute('aria-pressed',String(agtState.paused));
  byId('motionButton').title=agtState.paused?'继续播放所有画面动效':'暂停画面动效，任务数据继续更新';
  document.body.classList.toggle('motion-paused',agtState.paused);
  const focus=wallpaperHost()&&agtState.focusMode;
  document.body.classList.toggle('focus-mode',focus);
  byId('fullscreenButton').textContent=wallpaperHost()?(focus?'退出专注':'专注'):(fullscreen?'退出全屏':'全屏');
  byId('fullscreenButton').setAttribute('aria-pressed',String(wallpaperHost()?focus:fullscreen));
  byId('fullscreenButton').title=wallpaperHost()?'切换专注画面，保留顶部操作按钮':'切换浏览器全屏（F）';
}
async function toggleScreenMode(){
  if(wallpaperHost()){
    agtState.focusMode=!agtState.focusMode;syncScreenControls();
    toast(agtState.focusMode?'已进入专注画面，再次点击可恢复信息栏':'已恢复信息栏');
    return;
  }
  try{
    if(document.fullscreenElement)await document.exitFullscreen();
    else if(document.fullscreenEnabled&&document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();
    else throw Error('fullscreen unavailable');
    syncScreenControls();
  }catch{toast('当前窗口不支持全屏，请使用浏览器全屏按钮');}
}
function applyWallpaperProperties(p){
  if(p.showpanels){agtSettings.panelsCollapsed=!p.showpanels.value;applyScreenSettings();}
  if(p.showheader)document.body.classList.toggle('header-hidden',!p.showheader.value);
  if(p.camera)setParam('camera',p.camera.value?1:0,true);
  if(p.brightness){agtSettings.quiet=false;applyScreenSettings();byId('stage').style.opacity=Math.max(.15,Math.min(1,p.brightness.value/100));}
  if(p.ringspeed)setParam('ringSpeed',Number(p.ringspeed.value),true);
}
function applyWallpaperGeneral(p){if(p.fps)agtState.fps=Math.max(5,Math.min(60,Number(p.fps)));}
function agtSetHostPaused(paused){const was=agtState.wallpaperPaused;agtState.wallpaperPaused=!!paused;if(was&&!paused){agtWakeData();if(typeof agtWakeRender==='function')agtWakeRender();}}
window.wallpaperPropertyListener={applyUserProperties:p=>{if(window.agtWallpaperHost)window.agtWallpaperHost.native=true;applyWallpaperProperties(p);},applyGeneralProperties:p=>{if(window.agtWallpaperHost)window.agtWallpaperHost.native=true;applyWallpaperGeneral(p);},setPaused:paused=>{if(window.agtWallpaperHost)window.agtWallpaperHost.native=true;agtSetHostPaused(paused);}};
window.addEventListener('message',e=>{
  if(parent===window||e.source!==parent||!['null',location.origin].includes(e.origin)||e.data?.type!=='agt-wallpaper')return;
  if(e.data.properties)applyWallpaperProperties(e.data.properties);
  if(e.data.general)applyWallpaperGeneral(e.data.general);
  if(typeof e.data.paused==='boolean')agtSetHostPaused(e.data.paused);
});
function syncQualityControls(value=byId('qualityInput').value){
  const selected=['balanced','high','low'].includes(value)?value:'balanced';
  byId('qualityInput').value=selected;
  document.querySelectorAll('#qualityOptions [data-quality]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.quality===selected)));
}
function syncPanelViewControls(value=agtSettings.panelView){
  const selected=value==='original'?'original':'monitor';byId('panelViewInput').value=selected;
  document.querySelectorAll('#panelViewOptions [data-panel-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.panelView===selected)));
}
function agtBoot(){
  applyScreenSettings();
  if(window.agtWallpaperHost){const h=window.agtWallpaperHost;applyWallpaperProperties(h.properties);applyWallpaperGeneral(h.general);agtState.wallpaperPaused=h.paused;}
  byId('togglePanels').onclick=()=>{agtSettings.panelsCollapsed=!agtSettings.panelsCollapsed;saveScreenSettings();applyScreenSettings();};
  document.body.classList.toggle('wallpaper-host',wallpaperHost());
  const toolsToggle=byId('toolsToggle'),toolsMenu=byId('toolsMenu');
  const expandTools=open=>{toolsMenu.hidden=!open;toolsToggle.setAttribute('aria-expanded',String(open));toolsToggle.textContent=open?'菜单 ▴':'菜单 ▾';toolsToggle.title=open?'收起工作台操作':'展开工作台操作';};
  toolsToggle.onclick=()=>expandTools(toolsMenu.hidden);
  document.querySelector('.header-tools').addEventListener('click',e=>{if(e.target.closest('#tasksButton,#settingsButton,#consoleButton'))expandTools(false);});
  document.addEventListener('click',e=>{if(!e.target.closest('.header-tools'))expandTools(false);});
  byId('settingsButton').onclick=()=>{byId('nameInput').value=agtSettings.name;byId('quietInput').checked=agtSettings.quiet;byId('panelsInput').checked=!agtSettings.panelsCollapsed;syncQualityControls(agtSettings.quality);syncPanelViewControls();byId('settingsDialog').showModal();};
  byId('qualityOptions').onclick=e=>{const button=e.target.closest('[data-quality]');if(button)syncQualityControls(button.dataset.quality);};
  byId('panelViewOptions').onclick=e=>{const button=e.target.closest('[data-panel-view]');if(button)syncPanelViewControls(button.dataset.panelView);};
  byId('settingsDialog').addEventListener('close',()=>{if(byId('settingsDialog').returnValue!=='save')return;agtSettings={...agtSettings,name:byId('nameInput').value.trim()||'AGT 作战指挥台',quiet:byId('quietInput').checked,panelsCollapsed:!byId('panelsInput').checked,quality:byId('qualityInput').value,panelView:byId('panelViewInput').value};saveScreenSettings();applyScreenSettings();toast('设置已保存');});
  byId('motionButton').onclick=()=>{agtState.paused=!agtState.paused;syncScreenControls();if(!agtState.paused&&typeof agtWakeRender==='function')agtWakeRender();toast(agtState.paused?'动效已暂停，任务数据继续更新':'动效已继续');};
  toggleFS=toggleScreenMode;byId('fullscreenButton').onclick=toggleScreenMode;
  document.addEventListener('fullscreenchange',syncScreenControls);syncScreenControls();
  const showTasks=()=>{renderTaskDialog();byId('tasksDialog').showModal();};byId('tasksButton').onclick=showTasks;byId('allTasksButton').onclick=showTasks;byId('workspaceDetailsButton').onclick=showTasks;byId('closeTasks').onclick=()=>byId('tasksDialog').close();
  byId('activeOnly').onchange=e=>{agtState.activeOnly=e.target.checked;renderTaskDialog();};
  byId('includeSubagents').onchange=e=>{agtState.includeSubagents=e.target.checked;renderSnapshot();};
  byId('taskFilters').onclick=e=>{const b=e.target.closest('[data-filter]');if(!b)return;agtState.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(el=>el.classList.toggle('on',el===b));renderSnapshot();};
  for(const id of ['agents','taskList'])byId(id).onclick=e=>{const b=e.target.closest('[data-session]');if(b)selectTask(b.dataset.session);};
  const consoleButton=document.querySelector('.console');
  const syncConsole=()=>{const open=panel.classList.contains('open');consoleButton.setAttribute('aria-expanded',String(open));consoleButton.textContent=open?'收起调参':'调参';consoleButton.title=open?'关闭画面参数（C）':'打开画面参数（C）';};
  new MutationObserver(syncConsole).observe(panel,{attributes:true,attributeFilter:['class']});syncConsole();
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!toolsMenu.hidden){expandTools(false);toolsToggle.focus();}panel.classList.remove('open');if(agtState.focusMode){agtState.focusMode=false;syncScreenControls();}}});
  document.querySelectorAll('dialog,.header-tools,#taskFilters,#agents,#allTasksButton,#togglePanels').forEach(el=>el.addEventListener('dblclick',e=>e.stopPropagation()));
  bindTaskSceneInteraction();renderWorkspace();renderFeed();renderRoutes();renderAgents();pollAGT();
  if(typeof bindFlowControls==='function')bindFlowControls();
  if(parent!==window)parent.postMessage({type:'agt-ready'},'*');
}

/* The woven field is visual art; this sparse overlay contains only observed relations. */
const taskSceneState={nodes:[],curves:[],edgeIds:new Set(),signature:'',bursts:[],seenEvents:new Set(),ringBindings:new Map()};
const RING_PALETTE=['#eef0f6','#dce0eb','#f0a6c6','#e7eaf3','#b7a7ed','#98e0cf','#ece9f2','#d6d18f','#a9d9db'];
function stableHash(value){let h=2166136261;for(const c of String(value)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
const fraction=(key,salt=0)=>(stableHash(String(key)+':'+salt)%100000)/100000;
function sceneSessions(){return selectedSessions();}
function sceneTopology(){
  const topology=agtState.snapshot?.topology||{nodes:[],edges:[]};
  const visibleSessions=new Set(sceneSessions().map(s=>s.source+':'+s.id));
  const nodes=topology.nodes.filter(n=>(agtState.filter==='all'||n.source===agtState.filter)&&(n.kind==='source'||visibleSessions.has(n.source+':'+n.sessionId)));
  const ids=new Set(nodes.map(n=>n.id));
  return{nodes,edges:topology.edges.filter(e=>ids.has(e.from)&&ids.has(e.to))};
}
function sessionForNode(node){return sceneSessions().find(s=>s.source===node.source&&s.id===node.sessionId);}
function rebuildTaskGraph(){
  if(!Number.isFinite(R)||R<1)return;
  const topology=sceneTopology(),sessions=sceneSessions();
  const selected=sessions.find(s=>s.id===agtState.selected);
  const representatives=RINGS.map(r=>sessions.find(s=>s.source===r.id)).filter(Boolean);
  const candidates=[...(selected&&ringByAgent[selected.source]!=null?[selected]:[]),...representatives,...sessions.filter(s=>ringByAgent[s.source]!=null&&isActive(s))];
  const visibleSessions=candidates.filter((s,i)=>candidates.findIndex(v=>v.id===s.id)===i).slice(0,8);
  const keys=new Set(visibleSessions.map(s=>s.source+':'+s.id));
  const edges=topology.edges.filter(e=>keys.has(e.source+':'+e.sessionId)&&ringByAgent[e.source]!=null)
    .sort((a,b)=>Number(b.source+':'+b.sessionId===agtState.selected)-Number(a.source+':'+a.sessionId===agtState.selected)).slice(0,48);
  const ids=new Set(edges.flatMap(e=>[e.from,e.to]));
  const ordered=topology.nodes.filter(n=>ids.has(n.id));
  const innerRadius=RINGS.length?Math.max(40,Math.min(...RINGS.map(r=>r.R))-18):0;
  taskSceneState.innerRadius=innerRadius;
  const positions=haloInnerNodeLayout(ordered,innerRadius);
  const nodeMap=new Map();
  for(const node of ordered){
    nodeMap.set(node.id,{...node,...positions.get(node.id),session:sessionForNode(node)});
  }
  taskSceneState.nodes=[...nodeMap.values()];taskSceneState.curves=[];taskSceneState.edgeIds=new Set(topology.edges.map(e=>e.id));
  for(const edge of edges){
    const from=nodeMap.get(edge.from),to=nodeMap.get(edge.to);if(!from||!to)continue;
    const session=sessions.find(s=>s.id===edge.sessionId&&s.source===edge.source);
    const dx=to.x-from.x,dy=to.y-from.y,bend=.1;
    taskSceneState.curves.push({p0:from,p1:to,c:{x:(from.x+to.x)/2-dy*bend,y:(from.y+to.y)/2+dx*bend},edgeId:edge.id,source:edge.source,sessionId:edge.sessionId,active:isActive(session),selected:agtState.selected===edge.sessionId,phase:fraction(edge.id)});
  }
}
const buildVisualWeb=buildWeb;
buildWeb=function(){agtReleaseWebBuffers();buildVisualWeb();rebuildTaskGraph();};
function drawTaskGraph(dt,G){
  if(!taskSceneState.nodes.length||!taskSceneState.innerRadius)return;
  S.save();S.translate(cx,cy);S.globalCompositeOperation='source-over';
  const innerRadius=taskSceneState.innerRadius;
  S.beginPath();S.arc(0,0,innerRadius,0,TAU);S.clip();
  const AGC={codex:'223,230,238',dsh:'110,200,232',zcode:'230,168,66',workbuddy:'152,224,207'};
  const srcs=[...new Set(taskSceneState.curves.map(cv=>cv.source))];
  for(const selected of [false,true]){
    for(const sc of srcs){
      S.beginPath();
      for(const cv of taskSceneState.curves){if(cv.selected!==selected||cv.source!==sc)continue;S.moveTo(cv.p0.x,cv.p0.y);S.quadraticCurveTo(cv.c.x,cv.c.y,cv.p1.x,cv.p1.y);}
      const ac=AGC[sc]||'161,176,191';
      S.strokeStyle=selected?`rgba(${ac},.42)`:`rgba(${ac},.13)`;S.lineWidth=selected?.8:.45;S.stroke();
    }
  }
  for(const cv of taskSceneState.curves){
    if(!cv.active&&!cv.selected)continue;
    const ac=AGC[cv.source]||'185,242,223',t=(T*.4+cv.phase)%1,p=qpt(cv,t),tail=qpt(cv,Math.max(0,t-.025));
    S.strokeStyle=`rgba(${ac},.7)`;S.lineWidth=1;S.beginPath();S.moveTo(tail.x,tail.y);S.lineTo(p.x,p.y);S.stroke();
  }
  S.textBaseline='middle';
  for(const node of taskSceneState.nodes){
    const selected=node.sessionId&&agtState.selected===node.sessionId,active=isActive(node.session||node);
    if(!selected&&!active&&node.kind==='tool')continue;
    const radius=node.kind==='source'?4:node.kind==='session'?2.5:1.3;
    const ac=AGC[node.source]||'86,106,102';
    S.strokeStyle=`rgba(${ac},${selected?1:.8})`;S.lineWidth=selected?1.2:.7;S.beginPath();S.arc(node.x,node.y,radius,0,TAU);S.stroke();
    if(node.kind==='source'||node.kind==='session'){
      const label=node.kind==='source'?(node.label||node.source):node.label;
      S.font=`${node.kind==='source'?'600 9':'9'}px ${FONT}`;S.fillStyle=`rgba(${ac},.95)`;
      if(!selected&&!active&&node.kind==='session')S.globalAlpha=.6;
      const width=Math.max(20,Math.sqrt(Math.max(0,innerRadius*innerRadius-(node.y-10)**2))-node.x-18);
      agtPanelText(S,label,node.x+7,node.y-10,width);
      S.globalAlpha=1;
    }
  }
  S.restore();
}
function bindSlot(s){
  // 多环：槽位只绑定所属产品的会话（agent 由 _curRing 决定），按稳定哈希均匀排布
  const ring = RINGS[_curRing];
  const agent = ring ? ring.id : 'codex';
  const list = sceneSessions().filter(x => x.source === agent);
  const ringSlots = ring ? ring.slots : slots;
  const index = Math.max(0, ringSlots.indexOf(s));
  const session = list.length ? list[index % list.length] : null;
  const binding = { session, index, style: (index + (ring ? ring.phaseOff : 0)) % 12, agent };
  taskSceneState.ringBindings.set(s, binding); return binding;
}
function releaseTaskCards(currentSlots){
  const cur = currentSlots ?? slots;
  const retired=new Set(cur);
  for(const slot of retired)taskSceneState.ringBindings.delete(slot);
  for(const slot of retired)agtRetireCard(slot,false);
}
renderSlot=function(s){
  const band=RO-R,h=s.hpx;
  const scale=Math.max(s.c?s.cacheDpr||0:0,agtDesiredCardDpr());
  const pixelWidth=Math.max(1,Math.ceil(band*scale)),pixelHeight=Math.max(1,Math.ceil((h+2)*scale));
  const c=s.c||agtTakeCardCanvas(pixelWidth,pixelHeight),bucketWidth=Math.ceil(pixelWidth/64)*64,bucketHeight=Math.ceil(pixelHeight/32)*32;
  if(c.width<bucketWidth||c.height<bucketHeight){agtCardBackingResizes++;if(c.width<bucketWidth)c.width=bucketWidth;if(c.height<bucketHeight)c.height=bucketHeight;}
  s.cacheDpr=scale;s.sourceWidth=pixelWidth;s.sourceHeight=pixelHeight;
  const x=c.getContext('2d');x.setTransform(1,0,0,1,0,0);x.clearRect(0,0,c.width,c.height);x.setTransform(scale,0,0,scale,0,0);x.textBaseline='top';
  const binding=bindSlot(s),session=binding.session,margin=Math.max(8,rimW()+5),width=Math.max(10,band-margin*2),style=binding.style;
  x.fillStyle='#05090a';x.fillRect(0,0,band,h+2);x.save();x.beginPath();x.rect(margin,1,width,h);x.clip();
  x.font=`600 5px ${FONT}`;
  if(!session){x.fillStyle='#7b9186';x.fillText(haloEmptyText(binding.agent),margin,4,width);x.restore();s.c=c;return;}
  const key=session.id,selected=key===agtState.selected;
  const tintIndex=(binding.index+stableHash(session.id))%RING_PALETTE.length;
  const color=RING_PALETTE[tintIndex];
  x.fillStyle=selected?'#eafff2':color;x.fillText(session.title,margin,2,width);
  x.font=`4.6px ${FONT}`;x.fillStyle='#9faeaa';
  const tools=session.tools||[],samples=session.usageSamples||[],pct=occupancy(session);
  const tokTxt=session.hasTokens===false?['输入 未提供','输出 未提供','缓存 未提供']:[`输入 ${pretty(session.inputTokens)}`,`输出 ${pretty(session.outputTokens)}`,`缓存 ${pretty(session.cachedTokens)}`];
  const lines=[`来源 ${haloAgentLabel[session.source]??session.source} · ${statusText[session.status]}`,`模型 ${session.model}`,...tokTxt,`上下文 ${session.contextWindow?(pct*100).toFixed(1)+'%':'未提供'}`];
  const primaryWidth=width*.62;
  const textRows=(items,y=10,step=5.2)=>items.forEach((line,i)=>{if(y+i*step<h-2){x.fillStyle=RING_PALETTE[(tintIndex+i)%RING_PALETTE.length];x.fillText(String(line),margin,y+i*step,primaryWidth);}});
  const bars=(values,labels,y=12)=>{const max=Math.max(1,...values),row=Math.max(5,Math.min(9,(h-y-2)/Math.max(1,values.length)));values.forEach((value,i)=>{const yy=y+i*row;if(yy>h-2)return;x.fillStyle='#667c70';x.fillText(labels[i],margin,yy,24);if(typeof value==='number'){x.fillStyle=color;x.fillRect(margin+27,yy+1,Math.max(0,(width-55)*value/max),2);}x.fillStyle='#c2d6c9';x.fillText(compactValue(value),margin+width-24,yy,24);});};
  if(style===0||style===9){textRows(lines);}
  else if(style===1){bars([session.inputTokens,session.outputTokens,session.cachedTokens],['输入','输出','缓存']);}
  else if(style===2||style===10){textRows(tools.length?tools.slice(0,9).map(t=>`${toolLabel(t.name)} · 近 ${t.calls} 次 · ${statusText[t.status]||'已记录'}`):['暂无工具调用记录']);}
  else if(style===3){
    textRows([`输出 ${pretty(session.outputTokens)}`]);
    const observed=samples.slice(-25),values=observed.slice(1).map((v,i)=>Math.max(0,v.output-observed[i].output)),max=Math.max(1,...values),y=18,hh=Math.max(3,h-y-3);
    x.strokeStyle=color;x.lineWidth=.7;x.beginPath();values.forEach((v,i)=>{const px=margin+i/Math.max(1,values.length-1)*width,py=y+hh-v/max*hh;i?x.lineTo(px,py):x.moveTo(px,py);});x.stroke();
    if(values.length<2)textRows(['等待更多用量采样'],18);
  }else if(style===4){
    textRows([`任务编号 ${session.id.slice(-12)}`,`状态 ${statusText[session.status]}`,session.parentId?`主任务 ${session.parentId.slice(-12)}`:'主任务关系：未记录',`工具种类 ${tools.length}`]);
  }else if(style===5){
    textRows([`上下文 ${session.contextWindow?(pct*100).toFixed(1)+'%':'未提供'}`]);
    const cols=25,rows=Math.max(1,Math.floor((h-20)/4)),cw=width/cols;
    for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){x.fillStyle=session.contextWindow&&j*cols+i<Math.round(pct*cols*rows)?color:'#1c2822';x.fillRect(margin+i*cw,19+j*4,Math.max(.5,cw-1),2.5);}
  }else if(style===6){bars(tools.slice(0,6).map(t=>t.calls),tools.slice(0,6).map(t=>toolLabel(t.name).slice(0,5)));if(!tools.length)textRows(['暂无调用记录']);}
  else if(style===7){textRows(tools.length?tools.slice(0,7).map(t=>`${toolLabel(t.name)} · ${t.durationMs==null?'耗时未提供':t.durationMs+' 毫秒'}`):['耗时数据：未提供']);}
  else if(style===8){
    const events=(agtState.snapshot?.events||[]).filter(e=>e.session===session.id&&e.source===session.source).slice(0,7);
    textRows(events.length?events.map(e=>new Date(e.at*1000).toLocaleTimeString('zh-CN',{hour12:false})+' '+toolLabel(e.message)):['暂无近期事件']);
  }else{textRows([`当前工具 ${session.lastTool?toolLabel(session.lastTool):'暂无记录'}`,`状态 ${statusText[session.status]}`,`关联工具 ${tools.length} 种`,...lines.slice(2)]);}
  drawDenseTelemetry(x,session,binding,margin,width,h,tintIndex);
  x.restore();s.c=c;
};
function drawDenseTelemetry(x,session,binding,margin,width,h,tintIndex){
  const ox=margin+width*.65,w=width*.35-2,tools=session.tools||[],skills=typeof AVAILABLE_SKILLS==='undefined'?[]:AVAILABLE_SKILLS;
  const rgb=i=>RING_PALETTE[(tintIndex+i)%RING_PALETTE.length];
  x.fillStyle='#080a0e';x.fillRect(ox-2,9,w+4,h-9);x.strokeStyle='#313743';x.lineWidth=.45;x.beginPath();x.moveTo(ox-3,9);x.lineTo(ox-3,h);x.stroke();
  x.font=`600 3.9px ${FONT}`;
  const mode=binding.index%6;
  if(mode===0){
    const rows=[['输入',session.inputTokens],['输出',session.outputTokens],['缓存',session.cachedTokens],['工具',tools.length]];
    rows.forEach((row,i)=>{const y=11+i*6;if(y>h-3)return;x.fillStyle=rgb(i);x.fillText(row[0],ox,y);x.fillText(pretty(row[1]),ox+w*.38,y,w*.62);x.strokeStyle='#30343c';x.beginPath();x.moveTo(ox,y+4.9);x.lineTo(ox+w,y+4.9);x.stroke();});
  }else if(mode===1||mode===4){
    x.fillStyle=rgb(2);x.fillText('可用技能 '+skills.length,ox,10,w);
    for(let i=0,y=17;y<h-3&&i<skills.length;i++,y+=5.4){const skill=skills[(binding.index*3+i)%skills.length];x.strokeStyle=rgb(i);x.lineWidth=.5;x.strokeRect(ox,y+.3,3,3);x.fillStyle=rgb(i+2);x.fillText(skill.name,ox+5,y,w-5);}
  }else if(mode===2){
    x.fillStyle=rgb(1);x.fillText('工具 / 调用表',ox,10,w);
    tools.slice(0,8).forEach((tool,i)=>{const y=17+i*6;if(y>h-4)return;x.strokeStyle=rgb(i);x.strokeRect(ox,y+.5,3,3);x.fillStyle=rgb(i+2);x.fillText(toolLabel(tool.name),ox+5,y,w*.73);x.fillStyle=rgb(i+5);x.fillText(String(tool.calls),ox+w-9,y,9);});
    if(!tools.length){x.fillStyle='#697a83';x.fillText('暂无工具记录',ox,18,w);}
  }else if(mode===3){
    x.fillStyle=rgb(2);x.fillText('任务编号编码',ox,10,w);
    const bytes=Array.from(session.id).map(c=>c.charCodeAt(0));
    const cols=16,rows=Math.max(1,Math.floor((h-20)/3.5)),cw=w/cols;
    for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){const byte=bytes[Math.floor((j*cols+i)/8)%bytes.length],bit=(byte>>(i%8))&1;x.fillStyle=bit?rgb(j):'#252936';x.fillRect(ox+i*cw,18+j*3.5,Math.max(.4,cw-.7),2.5);}
  }else{
    x.fillStyle=rgb(1);x.fillText('上下文 '+(occupancy(session)*100).toFixed(1)+'%',ox,10,w);
    const n=24,cw=w/n;for(let i=0;i<n;i++){x.fillStyle=i/n<occupancy(session)?rgb(i):'#252936';x.fillRect(ox+i*cw,18,Math.max(.6,cw-.5),Math.max(4,h*.25));}
    x.font=`3.5px ${FONT}`;x.fillStyle=rgb(4);x.fillText(session.model,ox,Math.min(h-6,23+h*.25),w);
  }
  // Narrow index rail encodes the actual task identifier rather than random digits.
  x.font=`600 3px ${FONT}`;x.fillStyle=rgb(2);x.fillText(session.id.slice(-8),ox,Math.max(10,h-4),w);
}
function syncTaskScene(){
  const topology=sceneTopology();
  const signature=agtState.filter+'|'+agtState.selected+'|'+topology.nodes.map(n=>n.id+':'+n.status+':'+n.label).join(',')+'|'+topology.edges.map(e=>e.id+':'+e.status+':'+e.calls).join(',');
  if(signature!==taskSceneState.signature){taskSceneState.signature=signature;rebuildTaskGraph();}
  taskSceneState.ringBindings.clear();
  const stamps=new Map(sceneSessions().map(session=>[session.source+':'+session.id,JSON.stringify([
    session.id,session.title,session.model,session.status,session.inputTokens,session.outputTokens,session.cachedTokens,
    session.contextTokens,session.contextWindow,session.parentId,session.lastTool,session.lastAt,
    session.tools,session.usageSamples?.slice(-25).map(v=>v.output),agtState.selected===session.source+':'+session.id
  ])]));
  withRingEach((st, i) => {
    const agentSlots = st.slots;
    for(const slot of agentSlots){
      const binding=bindSlot(slot),session=binding.session;
      const stamp=session?stamps.get(session.source+':'+session.id):'ring:'+binding.agent+'|empty';
      if(slot.telemetryStamp!==stamp){slot.telemetryStamp=stamp;slot.dirty=true;}
    }
  });
  const now=Date.now()/1000;
  for(const event of agtState.snapshot?.events||[]){
    const key=event.id||event.source+':'+event.session+':'+event.at+':'+event.message;
    if(taskSceneState.seenEvents.has(key))continue;taskSceneState.seenEvents.add(key);
    if(now-event.at<7&&taskSceneState.bursts.length<12)taskSceneState.bursts.push({sessionId:event.session,source:event.source,label:toolLabel(event.message),failed:event.status==='failed',life:0});
  }
  if(taskSceneState.seenEvents.size>2000)taskSceneState.seenEvents=new Set([...taskSceneState.seenEvents].slice(-1000));
  { const sl = byId('sceneLegend'); if (sl) sl.textContent = `同心环 · 真实数据`; }
}
function drawTaskBursts(dt){
  S.save();camT(S,DPR);S.translate(cx,cy);S.globalCompositeOperation='lighter';
  for(let i=taskSceneState.bursts.length-1;i>=0;i--){
    const b=taskSceneState.bursts[i];b.life+=dt;if(b.life>2.2){taskSceneState.bursts.splice(i,1);continue;}
    const ringIdx = ringByAgent[b.source] ?? -1; if (ringIdx < 0) continue;
    withRing(ringIdx, () => {
      const matching=slots.filter(s=>{const v=taskSceneState.ringBindings.get(s)?.session;return v?.id===b.sessionId&&v?.source===b.source;});
      if(!matching.length)return;
      matching.sort((a,c)=>Math.abs(normA(a.a+ringRot))-Math.abs(normA(c.a+ringRot)));
      const slot=matching[0],angle=slot.a+ringRot,fade=Math.pow(1-b.life/2.2,1.4),length=(RMAX-RO)*Math.min(1,b.life/.35);
      const cs=Math.cos(angle),sn=Math.sin(angle);S.strokeStyle=b.failed?`rgba(240,166,198,${fade})`:`rgba(232,255,247,${fade})`;S.lineWidth=1.1;
      S.beginPath();for(let k=-7;k<=7;k++){const a=angle+k*.0016;S.moveTo(Math.cos(a)*(RO+2),Math.sin(a)*(RO+2));S.lineTo(Math.cos(a)*(RO+length),Math.sin(a)*(RO+length));}S.stroke();
      S.fillStyle=b.failed?'#f0a6c6':'#d4fff0';S.font=`8px ${FONT}`;S.fillText(b.label,cs*(RO+18),sn*(RO+18));slot.flash=Math.max(slot.flash,fade*.7);
    });
  }
  S.restore();
}
function bindTaskSceneInteraction(){
  const canvas=byId('stage');
  if(canvas.dataset.nodeInteraction)return;
  canvas.dataset.nodeInteraction='ready';canvas.tabIndex=0;
  canvas.setAttribute('aria-label','内场任务网络，左右方向键选择任务，Enter 监管');
  const tip=document.createElement('div');tip.id='nodeTooltip';tip.hidden=true;tip.setAttribute('role','status');byId('stageWrap').appendChild(tip);
  let hover=null,keyIndex=-1;
  const activate=node=>{
    if(!node)return;
    const session=node.session||sceneSessions().find(s=>s.source===node.source&&isActive(s))||sceneSessions().find(s=>s.source===node.source);
    if(session&&window.haloHudSettings)window.haloHudSettings.select(session.id,true);
  };
  const show=(px,py)=>{
    if(!hover){tip.hidden=true;canvas.style.cursor='default';return;}
    tip.hidden=false;tip.style.left=Math.max(8,Math.min(W-240,px+12))+'px';tip.style.top=Math.max(8,Math.min(H-80,py+12))+'px';
    const kind={source:'来源',session:'任务',tool:'工具'}[hover.kind];
    tip.textContent=`${kind}：${hover.session?.title||hover.label}\n${hover.session?.model||''}\n${hover.session?statusText[hover.session.status]||'已记录':'点击查看任务'} · 点击监管`;
    tip.style.borderColor='rgb('+agentIdentityRgb(hover.source).join(',')+')';canvas.style.cursor='pointer';
  };
  canvas.addEventListener('pointermove',e=>{
    const box=canvas.getBoundingClientRect(),px=e.clientX-box.left,py=e.clientY-box.top;
    const wx=(px-W/2)/cam.z+cam.x-cx,wy=(py-H/2)/cam.z+cam.y-cy;
    hover=taskSceneState.nodes.find(n=>Math.hypot(n.x-wx,n.y-wy)<14/cam.z)||null;show(px,py);
  });
  canvas.addEventListener('pointerleave',()=>{hover=null;tip.hidden=true;});
  canvas.addEventListener('click',()=>activate(hover));
  canvas.addEventListener('keydown',e=>{
    const nodes=taskSceneState.nodes.filter(n=>n.kind==='session');
    if(!nodes.length)return;
    if(e.key==='ArrowRight'||e.key==='ArrowLeft'){
      e.preventDefault();keyIndex=(keyIndex+(e.key==='ArrowRight'?1:-1)+nodes.length)%nodes.length;hover=nodes[keyIndex];
      const p=toScreen(cx+hover.x,cy+hover.y);show(p.x,p.y);
    }else if(e.key==='Enter'){e.preventDefault();activate(hover||nodes[0]);}
    else if(e.key==='Escape'){tip.hidden=true;hover=null;}
  });
}

/* 个人工作台：AGT 底部小面板画布不在本版本范围（HUD 用 DOM 仪器）。
 * 以下原参考函数保留签名做空操作，避免逐点移除调用。 */
function drawOriginalDiff() {
  const x = cDiff.x, w = cDiff.w, h = cDiff.h;
  x.clearRect(0, 0, w, h);
  x.font = `600 7px ${FONT}`; x.textBaseline = 'top';
  const gap = 8, mw = (w - gap) / 2, mh = h * 0.68, cols = 22, rows = 13, cw = mw / cols, ch = (mh - 10) / rows;
  const hist = new Array(28).fill(0);
  for (let m = 0; m < 2; m++) {
    const ox = m * (mw + gap);
    x.fillStyle = '#6b6f78'; x.fillText(m ? '原版动效' : '视觉参考', ox, 0);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      let v = 0.5 + 0.25 * Math.sin(i * 0.45 + T * 0.8) * Math.cos(j * 0.5 - T * 0.5) + 0.2 * Math.sin((i + j) * 0.3 + T);
      let err = 0;
      if (m) { const dx = i - 15 - Math.sin(T * 0.7) * 3, dy = j - 6; err = Math.exp(-(dx * dx + dy * dy) / 6) * (0.5 + 0.5 * Math.sin(T * 2)); v += err * 0.3; hist[Math.min(27, (err * 27) | 0)]++; }
      const g = Math.max(0, Math.min(255, v * 210 + 20)) | 0;
      x.fillStyle = err > 0.35 ? `rgba(240,166,198,${0.5 + err * 0.5})` : `rgb(${g},${g},${g + 4})`;
      x.fillRect(ox + i * cw, 10 + j * ch, cw - 0.6, ch - 0.6);
    }
  }
  const by = mh + 4, bh = h - by, bw = w / hist.length;
  const mx = Math.max(...hist.slice(1), 1);
  hist.forEach((v, i) => {
    const hh = i === 0 ? bh * 0.9 : (v / mx) * bh * 0.8 + 1;
    x.fillStyle = i > 9 ? '#f0a6c6' : '#8a8e97';
    x.fillRect(i * bw, by + bh - hh, bw - 1, hh);
  });
}


const ORIGINAL_PANEL_IDX = Array.from({ length: 11 }, () => Array.from({ length: 28 }, () => rnd()));
function drawOriginalIdx() {
  const x = cIdx.x, w = cIdx.w, h = cIdx.h;
  x.clearRect(0, 0, w, h);
  x.font = `600 6.5px ${FONT}`; x.textBaseline = 'middle';
  const lx = 24, rx = 34, rows = 11, cols = 28, cw = (w - lx - rx) / cols, ch = h / rows;
  const scan = Math.floor((T * 6) % cols);
  if (rnd() < 0.3) { const r = (rnd() * rows) | 0, c = (rnd() * cols) | 0; ORIGINAL_PANEL_IDX[r][c] = rnd(); }
  for (let j = 0; j < rows; j++) {
    x.fillStyle = '#6b6f78'; x.fillText('M' + String(j + 1).padStart(2, '0'), 0, j * ch + ch / 2);
    let match = 0;
    for (let i = 0; i < cols; i++) {
      const v = ORIGINAL_PANEL_IDX[j][i];
      x.fillStyle = v > 0.86 ? '#f0a6c6' : v > 0.7 ? 'rgba(240,166,198,.45)' : v > 0.4 ? '#4a4e56' : '#1c1e23';
      if (i === scan) x.fillStyle = v > 0.4 ? '#ffffff' : '#3a3e46';
      x.fillRect(lx + i * cw, j * ch + 1, cw - 1, ch - 2);
      if (v > 0.7) match++;
    }
    x.fillStyle = match > 7 ? '#f0a6c6' : '#9a9ea7';
    x.fillText(match > 7 ? '漂移' : '扫描', w - rx + 4, j * ch + ch / 2);
  }
}

/* HALOFLUX's slow advection field is visual art; the grids use observed metrics. */
const cAdv=byId('cAdv'),cDiff=byId('cDiff'),cIdx=byId('cIdx');
const flowState={mode:'advection',generation:0};
let flowParticles=[],flowGrid=null;
function panelsVisible(){return !agtState.focusMode&&!document.body.classList.contains('panels-collapsed')&&!document.body.classList.contains('pure-halo');}
let flowSeed=0x7b12ce;
function flowRandom(){flowSeed+=0x6D2B79F5;let t=flowSeed;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;}
function resetFlowParticle(p,index,initial=false){p.x=flowRandom()*cAdv.w;p.y=flowRandom()*cAdv.h;p.life=(initial?0:1)+flowRandom()*3;}
resizePanels=function(){
  if(flowGrid){flowGrid.width=1;flowGrid.height=1;flowGrid=null;}
  [cAdv,cDiff,cIdx].forEach(fit);
  flowParticles=Array.from({length:320},(_,i)=>{const p={};resetFlowParticle(p,i,true);return p;});
  flowGrid=mkd(cAdv.w,cAdv.h,1);
  flowGrid.x.fillStyle='rgba(120,125,135,.25)';
  for(let i=6;i<cAdv.w;i+=12)for(let j=6;j<cAdv.h;j+=12)flowGrid.x.fillRect(i,j,1,1);
  cAdv.dataset.flowMode=flowState.mode;
  if(typeof agtMarkPanelsDirty==='function')agtMarkPanelsDirty();
};
resizePanels=function(){
  if(flowGrid){flowGrid.width=1;flowGrid.height=1;flowGrid=null;}
  [cAdv,cDiff,cIdx].forEach(fit);
  flowParticles=Array.from({length:320},(_,i)=>{const p={};resetFlowParticle(p,i,true);return p;});
  flowGrid=mkd(cAdv.w,cAdv.h,1);
  flowGrid.x.fillStyle='rgba(120,125,135,.25)';
  for(let i=6;i<cAdv.w;i+=12)for(let j=6;j<cAdv.h;j+=12)flowGrid.x.fillRect(i,j,1,1);
};
function agtPanelText(ctx,value,x,y,width){
  let text=String(value??'');
  if(!(width>0))return;
  if(ctx.measureText(text).width>width){
    let low=0,high=text.length;
    while(low<high){const mid=Math.ceil((low+high)/2);if(ctx.measureText(text.slice(0,mid)+'…').width<=width)low=mid;else high=mid-1;}
    text=low?text.slice(0,low)+'…':'';
  }
  if(text)ctx.fillText(text,x,y);
}
// Match the original field and 22 px/s speed: the previous 65 px/s field
// changed direction more than twice as quickly, turning its curls into noise.
function flowAngle(x,y){return Math.sin(x*.035+T*.6)*Math.cos(y*.05-T*.4)*Math.PI+Math.sin((x+y)*.01+T*.2);}
function setFlowMode(mode){
  if(!['advection','projection','render'].includes(mode))return;
  flowState.mode=mode;cAdv.dataset.flowMode=mode;
  document.querySelectorAll('#advBtns [data-flow-mode]').forEach(button=>{
    const selected=button.dataset.flowMode===mode;
    button.classList.toggle('on',selected);button.setAttribute('aria-pressed',String(selected));
  });
  if(cAdv.x)cAdv.x.clearRect(0,0,cAdv.w,cAdv.h);
}
function bindFlowControls(){
  const modes=['advection','projection','render'];
  const descriptions=['原版平流：缓慢、连续的粒子轨迹','方向投影：查看流场方向箭头','轨迹渲染：突出粒子束与连续尾迹'];
  document.querySelectorAll('#advBtns button,#advBtns span').forEach((button,index)=>{
    button.dataset.flowMode=button.dataset.flowMode||modes[index];
    button.title=descriptions[index];
    if(button.tagName!=='BUTTON'){
      button.setAttribute('role','button');button.tabIndex=0;
      button.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setFlowMode(button.dataset.flowMode);}};
    }
    button.onclick=()=>setFlowMode(button.dataset.flowMode);
  });
  setFlowMode(flowState.mode);
}
function drawAdv(dt){
  const x=cAdv.x,w=cAdv.w,h=cAdv.h;if(!panelsVisible()||!x||w<1||h<1)return;
  const projection=flowState.mode==='projection',render=flowState.mode==='render';
  const fade=projection?1:1-Math.pow(render?.9:.78,Math.max(0,dt)*60);
  x.fillStyle=`rgba(14,15,18,${fade})`;x.fillRect(0,0,w,h);
  if(flowGrid)x.drawImage(flowGrid,0,0,w,h);
  if(projection){
    x.strokeStyle='rgba(152,224,207,.72)';x.lineWidth=.7;x.beginPath();
    for(let px=9;px<w;px+=18)for(let py=9;py<h;py+=18){
      const a=flowAngle(px,py),dx=Math.cos(a),dy=Math.sin(a),headX=px+dx*5,headY=py+dy*5;
      x.moveTo(px-dx*5,py-dy*5);x.lineTo(headX,headY);
      x.moveTo(headX-dx*2.6-dy*1.8,headY-dy*2.6+dx*1.8);x.lineTo(headX,headY);
      x.lineTo(headX-dx*2.6+dy*1.8,headY-dy*2.6-dx*1.8);
    }x.stroke();
  }
  x.beginPath();x.strokeStyle=projection?'rgba(238,243,255,.34)':render?'rgba(238,243,255,.9)':'rgba(235,238,244,.7)';x.lineWidth=render?1:.8;
  for(let i=0;i<flowParticles.length;i++){
    const p=flowParticles[i],a=flowAngle(p.x,p.y),dx=Math.cos(a),dy=Math.sin(a);
    const nx=p.x+dx*22*dt,ny=p.y+dy*22*dt;
    x.moveTo(p.x,p.y);x.lineTo(nx+dx*(render?3:2),ny+dy*(render?3:2));p.x=nx;p.y=ny;p.life-=dt;
    if(p.life<0||nx<0||nx>w||ny<0||ny>h)resetFlowParticle(p,i);
  }x.stroke();
}
function drawDiff(){
  const x=cDiff.x,w=cDiff.w,h=cDiff.h;if(!panelsVisible()||!x||w<1||h<1)return;
  x.clearRect(0,0,w,h);x.textBaseline='top';
  const font=w>=300?11:10,gap=12,left=Math.round((w-gap)*.48),right=left+gap,rw=w-right;
  x.font=`600 ${font}px ${FONT}`;x.fillStyle='#a9b4bd';x.fillText('来源 → 当前任务',0,0);x.fillText('当前上下文',right,0);
  const focus=focusedSession(),sources=haloState.sources;
  const bodyTop=font+10,footer=font+8,bodyH=Math.max(14,h-bodyTop-footer);
  const targetY=bodyTop+bodyH/2;
  const list=(sources||[]).slice(0,4);
  for(let i=0;i<Math.max(2,list.length);i++){
    const src=list[i]||{},has=!!src.id&&(src.sessions??0)>0,run=(src.running??0)>0,yy=bodyTop+(i+.5)*bodyH/Math.max(2,list.length);
    x.strokeStyle=run?'#98e0cf':has?'#5f8f83':'#333d44';x.lineWidth=run?1.2:.7;
    x.beginPath();x.moveTo(6,yy);x.bezierCurveTo(left*.35,yy,left*.65,targetY,left-8,targetY);x.stroke();
    x.fillStyle=run?'#98e0cf':has?'#5f8f83':'#4f5962';x.fillRect(1,yy-2,4,4);
    x.font=`${font}px ${FONT}`;
    const nm=src.id?(haloAgentLabel[src.id]??src.id):(i?'DSH':'Codex');
    agtPanelText(x,nm+(run?' · '+(src.running??0)+' 运行':has?' · '+(src.sessions??0)+' 会话':' · 无近期记录'),12,Math.round(yy-font-3),left-20);
  }
  x.fillStyle=focus?'#d4e4dc':'#63716c';x.fillRect(left-10,targetY-3,6,6);
  x.font=`${font}px ${FONT}`;agtPanelText(x,focus?focus.model:'等待任务',0,Math.round(h-footer),left);
  const known=!!focus?.contextWindow,pct=known?Math.min(1,focus.contextTokens/focus.contextWindow):0;
  x.fillStyle=pct>.8?'#f0a6c6':'#d1e4db';x.textAlign='right';x.font=`600 ${font}px ${FONT}`;x.fillText(known?(pct*100).toFixed(1)+'%':'未提供',w,0);x.textAlign='left';
  const cols=22,rows=8,cw=rw/cols,ch=Math.max(1,bodyH/rows);
  for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
    const index=j*cols+i,filled=known&&index<Math.round(pct*rows*cols);
    x.fillStyle=filled?(pct>.8?'#db94b4':'#92cbb8'):'#232a31';x.fillRect(right+i*cw,bodyTop+j*ch,Math.max(.5,cw-.7),Math.max(.5,ch-.8));
  }
  x.fillStyle='#a3b5ac';x.font=`${font}px ${FONT}`;agtPanelText(x,known?compactValue(focus.contextTokens)+' / '+compactValue(focus.contextWindow):'来源未报告上下文上限',right,Math.round(h-footer),rw);
}
function drawIdx(){
  const x=cIdx.x,w=cIdx.w,h=cIdx.h;if(!panelsVisible()||!x||w<1||h<1)return;
  x.clearRect(0,0,w,h);x.textBaseline='middle';
  const sessions=selectedSessions().slice(0,6),labels=['上下文','输入','输出','缓存'],font=w>=300?11:10;
  const left=Math.round(Math.min(96,w*.25)),right=30,cols=28,top=19,cw=(w-left-right)/cols,ch=(h-top)/6;
  x.font=`600 ${font}px ${FONT}`;
  for(let k=0;k<4;k++){x.fillStyle=['#98e0cf','#b7b4ce','#f0a6c6','#9f94bd'][k];x.fillText(labels[k],left+k*7*cw,6);}
  const maxima=[1,Math.max(1,...sessions.map(s=>s.inputTokens)),Math.max(1,...sessions.map(s=>s.outputTokens)),Math.max(1,...sessions.map(s=>s.cachedTokens))];
  const scan=Math.floor(T*6)%cols;
  for(let j=0;j<6;j++){
    const sess=sessions[j],values=sess?[occupancy(sess),sess.inputTokens,sess.outputTokens,sess.cachedTokens]:[0,0,0,0],yc=top+j*ch+ch/2;
    const sel2=sess&&agtState.selected===sess.source+':'+sess.id;
    x.fillStyle=sel2?'#ddede4':sess?'#889b91':'#39463e';x.font=`${font}px ${FONT}`;
    agtPanelText(x,sess?String(j+1).padStart(2,'0')+' '+(sess.title||'未命名'):'—',0,Math.round(yc),left-5);
    for(let i=0;i<cols;i++){
      const kind=Math.floor(i/7),level=(i%7+.5)/7,ratio=values[kind]/maxima[kind],filled=sess&&ratio>level;
      x.fillStyle=filled?['#98e0cf','#b7b4ce','#f0a6c6','#9f94bd'][kind]:'#252d33';
      if(i===scan&&filled)x.fillStyle='#f0f6f2';
      x.fillRect(left+i*cw,top+j*ch+1,Math.max(.5,cw-.8),Math.max(.5,ch-2));
    }
    x.fillStyle=sess&&isActive(sess)?'#f0a6c6':'#a2b4aa';if(sess)agtPanelText(x,isActive(sess)?'执行':'空闲',Math.round(w-right+3),Math.round(yc),right-3);
  }
}

const AGT_QUALITY={
  low:{pixels:1100000,dpr:1,web:650,runners:.3,comets:14,cards:4,trail:.65,flyers:4000,surfacePixels:900000,cardPixels:8000000,cardDpr:2.4,cardCache:64,farPixels:300000,fps:30,panelFps:30,fieldFps:30},
  balanced:{pixels:1700000,dpr:1.25,web:1000,runners:.48,comets:22,cards:5,trail:.8,flyers:6500,surfacePixels:1100000,cardPixels:12000000,cardDpr:2.4,cardCache:64,farPixels:450000,fps:60,panelFps:30,fieldFps:30},
  high:{pixels:2600000,dpr:1.5,web:1500,runners:.7,comets:30,cards:6,trail:1,flyers:10000,surfacePixels:1700000,cardPixels:16000000,cardDpr:3,cardCache:80,farPixels:700000,fps:60,panelFps:30,fieldFps:60}
};
let agtQuality=AGT_QUALITY[agtSettings.quality]||AGT_QUALITY.balanced;
let agtCardDpr=agtQuality.cardDpr,agtSharpDpr=1,agtFxCanvas=null;
let agtPanelsDirty=true,agtPanelPaintAt=0,agtNextDataPanelAt=0,agtPanelWakePending=false;
function agtMarkPanelsDirty(){
  agtPanelsDirty=true;
  // Pausing animation must not freeze newly received monitoring data.
  if(typeof ready!=='undefined'&&ready&&!document.hidden&&(agtState.paused||agtState.wallpaperPaused)&&!agtPanelWakePending){
    agtPanelWakePending=true;requestAnimationFrame(now=>{
      agtPanelWakePending=false;agtDrawDataPanels(now);
      if(agtFxCanvas&&!document.hidden&&(agtState.paused||agtState.wallpaperPaused)){
        const budget=agtQuality.cards;try{agtQuality.cards=slots.length;agtPaintInformationFrame(0);}finally{agtQuality.cards=budget;}
      }
    });
  }
}
function agtUiPixelRatio(){return Math.max(1,Math.min(2,window.devicePixelRatio||1));}
function agtNextDeadline(now,deadline,interval){return deadline?deadline+interval*Math.max(1,Math.floor((now-deadline)/interval)+1):now+interval;}
function agtDrawDataPanels(now){
  if(!panelsVisible())return;
  if(agtPanelsDirty||(agtSettings.panelView==='original'&&now+.75>=agtNextDataPanelAt)){
    agtPanelsDirty=false;agtPanelPaintAt=now;agtNextDataPanelAt=agtNextDeadline(now,agtNextDataPanelAt,1000/30);drawDiff();drawIdx();
  }
}
const agtAdaptive={level:0,fallback:false,startedAt:0,workMs:0,frames:0,slowWindows:0,goodWindows:0,cpuPressureWindows:0,resizePending:false,ignoreUntil:performance.now()+2500};
const agtRawTiming={last:null,spans:new Float64Array(16),cursor:0,count:0,total:0,reportAt:null,reportFrames:0};
function agtCanRenderFrame(now,interval){
  const timing=agtRawTiming;
  const latestGap=timing.last===null?null:now-timing.last;
  if(latestGap!==null){
    if(latestGap>0&&latestGap<100){
      if(timing.count===timing.spans.length)timing.total-=timing.spans[timing.cursor];
      else timing.count++;
      timing.spans[timing.cursor]=latestGap;
      timing.total+=latestGap;
      timing.cursor=(timing.cursor+1)%timing.spans.length;
    }else if(latestGap>=100){
      timing.count=0;timing.cursor=0;timing.total=0;
    }
  }
  timing.last=now;
  if(timing.reportAt===null)timing.reportAt=now;
  else{
    timing.reportFrames++;
    const elapsed=now-timing.reportAt;
    if(elapsed>=1000){
      window.agtRenderStats.rawRafFps=Number((timing.reportFrames*1000/elapsed).toFixed(2));
      timing.reportAt=now;timing.reportFrames=0;
    }
  }

  // The host already provides the desired cadence on a 60 Hz desktop.
  // Avoid rejecting its slightly early callbacks with a second limiter.
  // 宿主供帧 ≥ 目标时渲染每一帧（动画按 dt 缩放，72/90Hz 宿主全帧渲染比"每5帧拒1"更丝滑——
  // 后者产生 13/13/13/27ms 的突发间隔，视觉上是顿挫）。仅对明显超频宿主（均值 < 0.6×间隔）做节流。
  const hostPaces=latestGap>=interval*.75&&timing.count===timing.spans.length&&timing.total/timing.count>=interval*.85;
  if(hostPaces){nextFrameAt=now+interval;return true;}
  // 全帧渲染：动画按 dt 缩放，宿主任何节拍（60/72/101/144Hz）下全帧渲染都最平滑；
  // 非整数比节流必然产生突发间隔（实测 5.6/11.1 或 13/27 交替）= 用户可见的顿挫。
  // 负载过高由自适应画质（level/fallback 降低效果量）吸收，不丢帧。
  // 保留"按旧节拍本应拒帧"的计数仅供观测，不再真正拒帧。
  if(now+interval*.3<nextFrameAt){window.agtRenderStats.limiterSkips++;}
  nextFrameAt=agtNextDeadline(now,nextFrameAt,interval);
  return true;
}
function agtFxStride(){return agtAdaptive.level>=1?2:1;}
function agtPixelRatio(w,h){const scale=agtAdaptive.level>=2?.75:1;return scale*Math.min(window.devicePixelRatio||1,agtQuality.dpr,Math.sqrt(agtQuality.pixels/Math.max(1,w*h)));}
function agtSurfaceRatio(w,h,d){return Math.min(d,Math.sqrt(agtQuality.surfacePixels/Math.max(1,w*h)));}
function agtFrameRate(){return Math.min(agtState.fps,agtQuality.fps,agtAdaptive.fallback?30:60);}
function agtResizeStageSurfaces(){
  agtSharpDpr=agtUiPixelRatio();
  stage.width=Math.max(1,Math.round(W*agtSharpDpr));stage.height=Math.max(1,Math.round(H*agtSharpDpr));
  agtReleaseCanvas(agtFxCanvas);agtFxCanvas=document.createElement('canvas');
  agtFxCanvas.width=Math.max(1,Math.round(W*DPR));agtFxCanvas.height=Math.max(1,Math.round(H*DPR));agtFxCanvas.x=agtFxCanvas.getContext('2d');
  Object.assign(agtAdaptive,{startedAt:0,workMs:0,frames:0,slowWindows:0,goodWindows:0,cpuPressureWindows:0,ignoreUntil:performance.now()+1800});
  agtMarkPanelsDirty();
}
function agtScheduleFrame(callback){
  // Wallpaper Engine disables browser timer throttling. Explicitly sleep while covered.
  if(agtFrameRaf||agtSleepTimer)return;
  const queue=()=>{agtFrameRaf=requestAnimationFrame(now=>{agtFrameRaf=0;callback(now);});};
  if(document.hidden||agtState.paused||agtState.wallpaperPaused)agtSleepTimer=setTimeout(()=>{agtSleepTimer=0;queue();},250);
  else queue();
}
let agtFrameRaf=0,agtSleepTimer=0;
function agtWakeRender(){
  if(typeof started==='undefined'||!started)return;
  if(agtSleepTimer){clearTimeout(agtSleepTimer);agtSleepTimer=0;}
  last=performance.now();nextFrameAt=0;nextPanelAt=0;agtLastFrameStamp=0;
  Object.assign(agtRawTiming,{last:null,cursor:0,count:0,total:0,reportAt:null,reportFrames:0});
  Object.assign(agtAdaptive,{startedAt:0,workMs:0,frames:0,slowWindows:0,goodWindows:0,cpuPressureWindows:0,ignoreUntil:performance.now()+1800});
  agtScheduleFrame(frame);
}
let agtCardFrame=0;
const agtCardCanvasPool=[];
let agtCardBackingResizes=0;
function agtTakeCardCanvas(width,height){
  const bw=Math.ceil(width/64)*64,bh=Math.ceil(height/32)*32;
  let index=-1;
  for(let i=0;i<agtCardCanvasPool.length;i++){
    const c=agtCardCanvasPool[i];
    if(c.width>=bw&&c.height>=bh&&(index<0||c.width*c.height<agtCardCanvasPool[index].width*agtCardCanvasPool[index].height))index=i;
  }
  if(index<0)index=agtCardCanvasPool.findIndex(c=>c.width===1);
  if(index<0&&agtCardCanvasPool.length){
    let cost=Infinity;
    for(let i=0;i<agtCardCanvasPool.length;i++){
      const c=agtCardCanvasPool[i],growth=Math.max(bw,c.width)*Math.max(bh,c.height)-c.width*c.height;
      if(growth<cost){cost=growth;index=i;}
    }
  }
  if(index>=0)return agtCardCanvasPool.splice(index,1)[0];
  const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;return canvas;
}
function agtReleaseCardPool(){agtCardCanvasPool.forEach(agtReleaseCanvas);}
function agtRetireCard(slot,retain=true){
  const canvas=slot.c;if(!canvas)return;
  slot.c=null;slot.cacheDpr=0;
  if(!retain||agtCardCanvasPool.length>=24)agtReleaseCanvas(canvas);
  if(agtCardCanvasPool.length<24)agtCardCanvasPool.push(canvas);
}
function agtBeginCardFrame(){agtCardFrame++;}
function agtDesiredCardDpr(){const wanted=agtSharpDpr*cam.z;return Math.max(agtQuality.cardDpr,wanted>3?4:wanted>2.4?3:2.4);}
function agtTouchCard(slot){slot.lastPaintFrame=agtCardFrame;}
function agtTrimCardCache(){
  const cached=RINGS.flatMap(r => r.slots).filter(s => s.c);let pixels=cached.reduce((sum,s)=>sum+s.c.width*s.c.height,0),count=cached.length;
  const retired=cached.filter(s=>s.lastPaintFrame!==agtCardFrame).sort((a,b)=>(a.lastPaintFrame||0)-(b.lastPaintFrame||0));
  for(const slot of retired){
    if(count<=agtQuality.cardCache)break;
    pixels-=slot.c.width*slot.c.height;count--;agtRetireCard(slot);
  }
  let pooledPixels=agtCardCanvasPool.reduce((sum,c)=>sum+c.width*c.height,0);
  for(const canvas of agtCardCanvasPool){
    if(pixels+pooledPixels<=agtQuality.cardPixels)break;
    pooledPixels-=canvas.width*canvas.height-1;agtReleaseCanvas(canvas);
  }
  for(const slot of retired){
    if(pixels+pooledPixels<=agtQuality.cardPixels)break;
    if(!slot.c)continue;
    pixels-=slot.c.width*slot.c.height;agtRetireCard(slot,false);
  }
}
window.agtSetQuality=function(name){
  const next=AGT_QUALITY[name]||AGT_QUALITY.balanced;
  if(next===agtQuality)return;
  agtQuality=next;agtCardDpr=next.cardDpr;Object.assign(agtAdaptive,{level:0,fallback:false,startedAt:0,workMs:0,frames:0,slowWindows:0,goodWindows:0,cpuPressureWindows:0});
  if(started)requestAnimationFrame(resizeAll);
};
function agtPaintPausedFrame(){
  const budget=agtQuality.cards;
  try{agtQuality.cards=slots.length;drawStage(0);drawAdv(0);drawDiff();drawIdx();}
  finally{agtQuality.cards=budget;}
}
function agtReleaseCanvas(canvas){if(canvas){canvas.width=1;canvas.height=1;}}
function agtReleaseWebBuffers(){
  [webBase,...webLayers,agtArtComposite].forEach(agtReleaseCanvas);
  webBase=null;webLayers=[];agtArtComposite=null;agtArtSource=null;
}
function agtReleaseStageBuffers(){
  agtReleaseWebBuffers();
  [trailC,farC,glowC,laneC,agtGlowBlur,agtFxCanvas].forEach(agtReleaseCanvas);
  agtReleaseCardPool();
  agtGlowBlur=null;
}
const spawnVisualComet=spawnComet;
spawnComet=function(){if(comets.length<agtQuality.comets)spawnVisualComet();};
const spawnVisualFlyBurst=spawnFlyBurst;
spawnFlyBurst=function(){if(flyers.length>=agtQuality.flyers)return;spawnVisualFlyBurst();if(flyers.length>agtQuality.flyers)flyers.length=agtQuality.flyers;};
let agtArtComposite=null,agtArtSource=null,agtArtAt=-1,agtArtNextAt=0;
function drawArtField(){
  const ws=2*R+4;
  if(agtArtSource!==webBase){agtReleaseCanvas(agtArtComposite);agtArtSource=webBase;agtArtComposite=mkd(ws,ws,Math.min(DPR,agtQuality.trail));agtArtAt=-1;agtArtNextAt=0;}
  if(agtArtAt<0||T+.00075>=agtArtNextAt){
    agtArtAt=T;agtArtNextAt=agtNextDeadline(T,agtArtNextAt,1/agtQuality.fieldFps);const x=agtArtComposite.x;x.globalAlpha=1;x.globalCompositeOperation='source-over';x.drawImage(webBase,0,0,ws,ws);
    x.globalCompositeOperation='lighter';
    webLayers.forEach((c,k)=>{x.globalAlpha=Math.min(1,C.webPulseBase+C.webPulseAmp*layerEnv[k]);x.drawImage(c,0,0,ws,ws);});x.globalAlpha=1;
  }
  S.drawImage(agtArtComposite,-R-2,-R-2,ws,ws);S.globalCompositeOperation='lighter';
}
const drawEffectStage=drawStage;
function agtPaintInformationFrame(dt){
  const previousDpr=DPR,previousContext=S,previousMain=S_MAIN;
  try{
    S=agtSharpContext;S_MAIN=S;DPR=agtSharpDpr;
    S.setTransform(1,0,0,1,0,0);S.globalAlpha=1;S.globalCompositeOperation='copy';S.drawImage(agtFxCanvas,0,0,stage.width,stage.height);S.globalCompositeOperation='source-over';
    camT(S,DPR);drawTaskGraph(dt,glowC.x);
    // 同心数据环带：锐利信息层逐环绘制（效果层只管光场/辉光，不画环带）
    withRingEach((st, i) => {
      st.intensity += ((haloRingActivity(st.id)) - st.intensity) * Math.min(1, dt * 3);
      drawRing(dt);
    });
    drawIdentityComets();
    drawTaskBursts(dt);
    S.setTransform(DPR,0,0,DPR,0,0);   // 引线浮标用屏幕空间
    drawCallout();
  }finally{DPR=previousDpr;S=previousContext;S_MAIN=previousMain;}
}

function drawIdentityComets(){
  S.save();S.translate(cx,cy);S.globalCompositeOperation='lighter';S.lineCap='round';
  for(const c of comets){
    if(!c.identity)continue;
    const ring=RINGS.find(r=>r.id===c.ringId);if(!ring)continue;
    const p=easeIO(Math.min(1,c.life/c.dur)),head=Math.min(1,p*(1+c.win)),tail=Math.max(0,p*(1+c.win)-c.win);
    const fade=c.life>c.dur?Math.max(0,1-(c.life-c.dur)/.25):1;
    if(fade<=0)continue;
    S.save();S.rotate(ring.ringRot-c.rot0);
    S.strokeStyle=`rgba(${c.identity},${Math.min(1,.65*fade*C.cometBright)})`;S.lineWidth=.8;
    strokeComet(S,c,tail,head,18);
    S.shadowColor=`rgb(${c.identity})`;S.shadowBlur=3*C.cometGlow;
    S.strokeStyle=`rgba(${c.identity},${Math.min(1,fade*C.cometBright)})`;S.lineWidth=1.3;
    strokeComet(S,c,head-(head-tail)*.35,head,8);S.restore();
  }
  S.restore();
}
drawStage=function(dt){
  const begin=performance.now();
  try{S=agtFxCanvas.x;S_MAIN=S;drawEffectStage(dt);agtPaintInformationFrame(dt);}
  finally{S=agtSharpContext;S_MAIN=S;}
  agtMeasureWork(performance.now()-begin);
};
function agtMeasureWork(ms){
  const now=performance.now(),a=agtAdaptive;
  if(document.hidden||agtState.paused||agtState.wallpaperPaused||now<a.ignoreUntil)return;
  if(!a.startedAt){a.startedAt=now;return;}
  a.workMs+=ms;a.frames++;
  if(now-a.startedAt<2000)return;
  const average=a.workMs/Math.max(1,a.frames);window.agtRenderStats.workMs=Number(average.toFixed(2));
  const actualFps=a.frames*1000/(now-a.startedAt);
  window.agtRenderStats.measuredFps=Number(actualFps.toFixed(2));
  const targetFps=agtFrameRate();
  // 闸门（agtCanRenderFrame）按节拍拒帧是设计行为：由此造成的 actualFps 偏低不代表负载过重，
  // 否则 IAB/抖动环境下会无收益地连降画质（DPR 0.75 变糊 + 卡片缓存清空）。仅当拒帧不足以解释缺口时才记慢窗。
  const skipsDelta=window.agtRenderStats.limiterSkips-(a.lastSkips||0);a.lastSkips=window.agtRenderStats.limiterSkips;
  // 宿主 RAF 供给不足（rawRafFps 低于目标）时掉帧与画质无关，降档无收益（实测 IAB 45~160Hz 波动）
  const rafDeficit=(window.agtRenderStats.rawRafFps||60)<targetFps*.92;
  const overloaded=targetFps>=55&&(average>14||(actualFps<53&&skipsDelta<10&&!rafDeficit));
  a.slowWindows=overloaded?a.slowWindows+1:0;a.goodWindows=average<8&&actualFps>=targetFps*.95?a.goodWindows+1:0;
  a.cpuPressureWindows=a.level>=2&&targetFps>=55&&average>14?a.cpuPressureWindows+1:0;
  if(a.slowWindows>=2){
    a.slowWindows=0;
    if(a.level<2){a.level++;if(a.level===2&&!a.resizePending){a.resizePending=true;requestAnimationFrame(()=>{a.resizePending=false;resizeAll();});}}
  }
  // A slow host callback is reason to trim effects, not proof of CPU overload.
  if(a.cpuPressureWindows>=4)a.fallback=true;
  // Recover only after a long quiet period; avoid repeated buffer resizing.
  if(a.goodWindows>=15){a.goodWindows=0;if(a.fallback)a.fallback=false;else if(a.level>0){a.level--;if(a.level===1)requestAnimationFrame(resizeAll);}}
  Object.assign(window.agtRenderStats,{effectsLevel:a.level,fallback:a.fallback});a.startedAt=now;a.workMs=0;a.frames=0;
}
window.agtRenderStats={fps:0,targetFps:60,workMs:0,effectsLevel:0,fallback:false,frames:0,frameP50Ms:0,frameP95Ms:0,frameP99Ms:0,frameMaxMs:0,frameSamples:0,measuredFps:0,rawRafFps:0,limiterSkips:0};
let agtStatsAt=0,agtStatsFrames=0,agtLastFrameStamp=0;
const agtFrameIntervals=[];
function agtNoteFrame(now){
  if(agtLastFrameStamp&&now>agtLastFrameStamp&&now-agtLastFrameStamp<500){agtFrameIntervals.push(now-agtLastFrameStamp);if(agtFrameIntervals.length>240)agtFrameIntervals.shift();}
  agtLastFrameStamp=now;window.agtRenderStats.frames++;
  if(!agtStatsAt){agtStatsAt=now;agtStatsFrames=0;return;}
  agtStatsFrames++;
  if(now-agtStatsAt>=1000){
    const stats=window.agtRenderStats;stats.fps=Math.round(agtStatsFrames*1000/(now-agtStatsAt));stats.targetFps=agtFrameRate();
    const sorted=[...agtFrameIntervals].sort((a,b)=>a-b),percentile=q=>Number((sorted[Math.floor((sorted.length-1)*q)]||0).toFixed(2));
    const cardCanvases=[...RINGS.flatMap(r => r.slots).map(s => s.c),...agtCardCanvasPool].filter(Boolean);
    Object.assign(stats,{frameP50Ms:percentile(.5),frameP95Ms:percentile(.95),frameP99Ms:percentile(.99),frameMaxMs:percentile(1),frameSamples:sorted.length,cardCanvases:cardCanvases.length,cardPixels:cardCanvases.reduce((sum,c)=>sum+c.width*c.height,0),cardBackingResizes:agtCardBackingResizes,stageDpr:agtSharpDpr});
    const label=byId('renderFps');if(label)label.textContent=`实际 ${stats.fps} FPS · 目标 ${stats.targetFps} FPS`;
    agtStatsAt=now;agtStatsFrames=0;
  }
}
function drawArtRunners(dt){
  const tx=trailC.x,ws=2*R+4,surge=.5+2.5*env;
  const count=Math.max(0,Math.round(C.runnerCount*agtQuality.runners));
  while(runners.length<count)runners.push(newRunner(true));
  if(runners.length>count)runners.length=count;
  tx.globalCompositeOperation='destination-out';
  tx.fillStyle=`rgba(0,0,0,${1-Math.exp(-dt*(3.2+env*3))})`;tx.fillRect(0,0,ws,ws);
  tx.globalCompositeOperation='source-over';tx.save();tx.translate(R+2,R+2);tx.lineCap='round';
  const paths=[new Path2D(),new Path2D()];
  for(let i=0;i<runners.length;i++){
    const r=runners[i];r.t+=dt*C.runnerSpeed*(r.mode===1?r.sp*surge:r.mode===2?r.sp+1.3*r.t*r.t:r.sp);
    if(r.t>=1){runners[i]=newRunner(false);continue;}
    const p=qpt(r.cv,r.t),path=paths[r.b?1:0];path.moveTo(r.px,r.py);path.lineTo(p.x,p.y);r.px=p.x;r.py=p.y;
  }
  tx.lineWidth=.9*C.runnerWidth;tx.strokeStyle=`rgba(250,251,255,${Math.min(1,.75*C.runnerBright)})`;tx.stroke(paths[0]);
  tx.lineWidth=1.3*C.runnerWidth;tx.strokeStyle=`rgba(240,166,198,${Math.min(1,.9*C.runnerBright)})`;tx.stroke(paths[1]);
  tx.restore();S.drawImage(trailC,-R-2,-R-2,ws,ws);
}
let agtGlowBlur=null;
function compositeGlow(){
  if(C.glow<=0)return;
  if(!agtGlowBlur||agtGlowBlur.width!==glowC.width||agtGlowBlur.height!==glowC.height){agtReleaseCanvas(agtGlowBlur);agtGlowBlur=mkd(glowC.width,glowC.height,1);}
  const x=agtGlowBlur.x;x.clearRect(0,0,agtGlowBlur.width,agtGlowBlur.height);
  if(HAS_FILTER)x.filter='blur(2px)';x.drawImage(glowC,0,0);if(HAS_FILTER)x.filter='none';
  S.globalAlpha=Math.min(1,.9*C.glow);S.drawImage(agtGlowBlur,0,0,W,H);S.globalAlpha=1;
}

/* DeskGo compatibility: authenticated, bounded controls only; no native window messages. */
function agtStartDesktopControls(){
  if(!window.agtWallpaperHost)return;
  if(window.agtDesktopControlStarted)return;
  if(!window.agtWallpaperHost.native){if(!window.agtDesktopControlWaiter)window.agtDesktopControlWaiter=setInterval(()=>{if(window.agtWallpaperHost.native){clearInterval(window.agtDesktopControlWaiter);window.agtDesktopControlWaiter=null;agtStartDesktopControls();}},500);return;}
  window.agtDesktopControlStarted=true;
  const host=window.agtWallpaperHost,clientId=crypto.randomUUID(),keys=new WeakMap(),targets=new Map();let serial=0,busy=false,publishing=false,acknowledged=0;
  const headers={'X-AGT-Token':host.token,'Content-Type':'application/json'};
  function regions(){
    targets.clear();const modal=document.querySelector('dialog[open]'),scope=modal||document;
    return [...scope.querySelectorAll('button,a,input[type=range],input[type=checkbox]')].filter(el=>{
      const r=el.getBoundingClientRect();return !el.disabled&&r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden';
    }).slice(0,200).map(el=>{
      if(!keys.has(el))keys.set(el,'control-'+(++serial));const key=keys.get(el),r=el.getBoundingClientRect();targets.set(key,el);
      return{key,x:r.x,y:r.y,width:r.width,height:r.height,kind:el.type==='range'?'range':'click'};
    });
  }
  async function publish(){
    if(publishing)return;publishing=true;
    try{await fetch(host.api+'/api/ui',{method:'POST',headers,signal:AbortSignal.timeout(2000),body:JSON.stringify({clientId,
      screen:{x:screen.availLeft||0,y:screen.availTop||0,width:screen.width,height:screen.height},
      viewport:{width:innerWidth,height:innerHeight},regions:regions(),acknowledged,hostPaused:!!agtState.wallpaperPaused,pageHidden:document.hidden,
      renderStats:window.agtRenderStats||{}})});}catch{}finally{publishing=false;}
  }
  async function receive(){
    if(busy||document.hidden||agtState.wallpaperPaused)return;busy=true;
    try{
      const response=await fetch(host.api+'/api/ui?clientId='+encodeURIComponent(clientId),{headers:{'X-AGT-Token':host.token},signal:AbortSignal.timeout(2000)});
      if(response.ok)for(const cmd of (await response.json()).commands||[]){
        const el=targets.get(cmd.key);if(!el?.isConnected||el.disabled)continue;
        if(cmd.type==='click')el.click();
        if(cmd.type==='input'&&el.type==='range'){
          const min=Number(el.min||0),max=Number(el.max||100),step=Number(el.step)||1;
          el.value=String(Math.max(min,Math.min(max,min+Math.round((max-min)*cmd.ratio/step)*step)));el.dispatchEvent(new Event('input',{bubbles:true}));
        }
        acknowledged++;
      }
    }catch{}finally{busy=false;}
  }
  publish();setInterval(publish,2000);setInterval(receive,100);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){publish();receive();}});
  document.addEventListener('click',()=>setTimeout(publish,0),true);
}

/* =========================================================
   LOOP
   ========================================================= */
let last = performance.now(), nextFrameAt=0, lastPanelAt=0, nextPanelAt=0;
function frame(now) {
  if (document.hidden || agtState.paused || agtState.wallpaperPaused) { last=now; nextFrameAt=0; lastPanelAt=now; nextPanelAt=0; agtScheduleFrame(frame); return; }
  const interval=1000/agtFrameRate();
  if (!agtCanRenderFrame(now,interval)) { agtScheduleFrame(frame); return; }
  const dt = Math.min(.1, Math.max(0,(now-last)/1000)); last=now; T+=dt;agtNoteFrame(now);
  drawStage(dt);
  if(now+.75>=nextPanelAt){const panelDt=Math.min(.25,(now-lastPanelAt)/1000);lastPanelAt=now;nextPanelAt=agtNextDeadline(now,nextPanelAt,1000/agtQuality.panelFps);drawAdv(panelDt);}
  agtDrawDataPanels(now);
  agtScheduleFrame(frame);
}
let rzT, ready = false, started = false;
function resizeAll() {
  const r = stage.getBoundingClientRect();
  if (r.width < 20 || r.height < 20) { ready = false; return; }
  DPR = agtPixelRatio(r.width,r.height); resizeStage(); resizePanels(); ready = true; if(agtState.paused||agtState.wallpaperPaused)agtPaintPausedFrame();
  if (!started) { started = true; last = performance.now(); agtScheduleFrame(frame); }
}
const origFrame = frame;
frame = function (now) {
    if (ready) {
      const __t0 = performance.now();
      try { origFrame(now); }
      catch (e) { window.__frameErrs = window.__frameErrs ?? []; if (window.__frameErrs.length < 5) window.__frameErrs.push(e.message); agtScheduleFrame(frame); }
      const P = window.haloPerf = window.haloPerf || { iv: [], wk: [], last: 0 };
      if (P.last) { P.iv.push(now - P.last); if (P.iv.length > 600) P.iv.shift(); }
      P.wk.push(performance.now() - __t0); if (P.wk.length > 600) P.wk.shift();
      P.last = now;
    } else { last = now; agtScheduleFrame(frame); }
  };
new ResizeObserver(() => { clearTimeout(rzT); rzT = setTimeout(resizeAll, 120); }).observe(document.getElementById('stageWrap'));
let panelResizeFrame=0;
const panelObserver=new ResizeObserver(()=>{
  if(panelResizeFrame)return;
  panelResizeFrame=requestAnimationFrame(()=>{panelResizeFrame=0;if(panelsVisible()){resizePanels();agtMarkPanelsDirty();}});
});
[cAdv,cDiff,cIdx].forEach(canvas=>panelObserver.observe(canvas.parentElement));
(document.fonts ? document.fonts.ready : Promise.resolve()).then(resizeAll);

// fullscreen: double-click anywhere or press F
/* 检查模式：双击环 → 相机凑近该环数据卡持续跟踪查看；再双击（任意处）或 Esc → 恢复原跟随状态。
 * 与全屏双击共存：命中环或处于检查模式时 stopPropagation，空白双击仍走全屏。 */
function enterInspect(agent) {
  const idx = ringByAgent[agent];
  if (idx == null || !RINGS[idx]) return;
  if (window.haloInspect) { exitInspect(); return; }   // 已在检查模式：本次双击 = 退出
  window.haloInspect = { agent, prevAuto: window.haloAutoFollow, prevFollow: window.haloFollowAgent, prevKey: window.haloFollowKey };
  window.haloAutoFollow = false;
  const rep2 = [...haloState.sessions.values()].filter(x => x.agent === agent && ['thinking', 'streaming', 'tool'].includes(x.state)).sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0];
  window.haloFollowAgent = agent; window.haloFollowKey = rep2 ? rep2.key : null;
  if (typeof window.haloSelectSession === 'function') window.haloSelectSession(agent, window.haloFollowKey);
  buildShots.soft = true; buildShots(); agtWakeRender();
  const hint = document.getElementById('inspectHint');
  if (hint) { hint.hidden = false; hint.textContent = '检查模式 · ' + (haloAgentLabel[agent] ?? agent) + ' — 双击任意处退出'; }
}
function exitInspect() {
  const prev = window.haloInspect;
  if (!prev) return;
  window.haloInspect = null;
  window.haloAutoFollow = prev.prevAuto;
  window.haloFollowAgent = prev.prevFollow; window.haloFollowKey = prev.prevKey;
  buildShots.soft = true; buildShots(); agtWakeRender();
  const hint = document.getElementById('inspectHint');
  if (hint) hint.hidden = true;
}
function bindHaloInspect() {
  const stage = document.getElementById('stage');
  if (!stage || stage.dataset.inspectBound) return;
  stage.dataset.inspectBound = '1';
  const wrap = document.getElementById('stageWrap');
  if (wrap && !document.getElementById('inspectHint')) {
    const hint = document.createElement('div');
    hint.id = 'inspectHint'; hint.hidden = true;
    hint.style.cssText = 'position:absolute;top:40px;left:50%;transform:translateX(-50%);z-index:30;font-size:11px;color:#d6d18f;background:#0b0d12d9;border:1px solid #4b4426;border-radius:4px;padding:4px 12px;pointer-events:none';
    wrap.appendChild(hint);
  }
  stage.addEventListener('dblclick', e => {
    const r = stage.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const hit = window.haloHitTest && window.haloHitTest(px, py);
    if (window.haloInspect) { exitInspect(); e.stopPropagation(); return; }   // 检查中：任意双击退出
    if (hit && hit.ring != null) { enterInspect(hit.agent); e.stopPropagation(); return; }   // 命中环：进入检查
    // 空白双击：不拦截，走全屏
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && window.haloInspect) exitInspect(); });
}
function toggleFS() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
document.addEventListener('dblclick', toggleFS);
document.addEventListener('keydown', e => { if (e.target.matches('input,textarea,select') || e.ctrlKey || e.metaKey || e.altKey) return; if (e.key === 'f' || e.key === 'F') toggleFS(); });

/* =========================================================
   画面参数 — live tuning panel (click 画面参数 or press C)
   ========================================================= */
const LS_KEY = 'personal-halo.live.cfg.v1';
let curPreset = 'B';
function lsGet() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; } }
function lsSet(v) { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch (e) {} }
function saveCfg() { lsSet({ preset: curPreset, values: { ...C } }); }
const MINE_KEY = LS_KEY.replace('cfg', 'mine');
try { const m = JSON.parse(localStorage.getItem(MINE_KEY) || 'null'); if (m) PRESETS.MINE = { ...BASE, ...(BAKED_MINE || {}), ...m }; } catch (e) {}
// MINE 预设即 AGT 原作动势参考（BAKED_MINE 源码默认）；未保存个人默认时以它为起点。

const rebuildQ = new Set();
let rebuildT;
function applyRebuilds() {
  if (!ready) return;
  if (rebuildQ.has('resize')) { resizeAll(); rebuildQ.clear(); return; }
  if (rebuildQ.has('web')) buildWeb();
  if (rebuildQ.has('slots')) slots.forEach(s => s.dirty = true);
  if (rebuildQ.has('flyers')) initFlyers();
  rebuildQ.clear();
}
function setParam(k, v, silent) {
  C[k] = v;
  if (k === 'scan') document.body.classList.toggle('noscan', !v);
  const p = PARAMS.find(p => p[0] === k);
  if (p && p[6]) { rebuildQ.add(p[6]); clearTimeout(rebuildT); rebuildT = setTimeout(applyRebuilds, 250); }
  if (!silent) saveCfg();
}
function loadPreset(name, values) {
  curPreset = name;
  const src = values || PRESETS[name];
  for (const k in PRESETS[name]) setParam(k, src[k] != null ? src[k] : PRESETS[name][k], true);
  rebuildQ.add('web'); rebuildQ.add('flyers'); rebuildQ.add('slots'); rebuildQ.add('resize');
  clearTimeout(rebuildT); rebuildT = setTimeout(applyRebuilds, 50);
  saveCfg(); syncPanel();
}

// ---- panel DOM ----
const css = document.createElement('style');
css.textContent = `
.noscan .stage::after{display:none}
.console{pointer-events:auto!important;cursor:pointer;user-select:none}
.console:hover{border-color:#cfd2d8;color:#fff}
#cpanel{position:fixed;top:64px;left:12px;bottom:12px;width:340px;max-width:calc(100vw - 24px);z-index:50;
  background:rgba(9,10,12,.95);border:1px solid var(--line2);display:none;flex-direction:column;font-size:10px;color:var(--text);
  backdrop-filter:blur(4px)}
#cpanel.open{display:flex}
#cpanel .top{padding:10px 12px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:6px;align-items:center}
#cpanel .top b{font-size:11px;letter-spacing:1.5px;color:var(--white);margin-right:auto}
#cpanel button{background:#15171b;color:var(--text);border:1px solid var(--line2);font:inherit;padding:4px 8px;cursor:pointer}
#cpanel button:hover{border-color:#cfd2d8;color:#fff}
#cpanel button.on{background:#cfd2d8;color:#000;border-color:#cfd2d8}
#cpanel .body{overflow:auto;flex:1;padding:4px 12px 12px}
#cpanel details{border-bottom:1px solid var(--line);padding:6px 0}
#cpanel summary{cursor:pointer;font-weight:800;letter-spacing:1.5px;color:var(--white);padding:4px 0;list-style:none}
#cpanel summary::before{content:'▸ ';color:var(--dim)}
#cpanel details[open] summary::before{content:'▾ '}
#cpanel .row{display:grid;grid-template-columns:1fr 96px 40px;gap:6px;align-items:center;padding:3px 0}
#cpanel .row label{color:#aeb2bb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cpanel .row.chg label{color:var(--pink)}
#cpanel input[type=range]{width:100%;accent-color:#cfd2d8;height:14px;margin:0}
#cpanel input[type=number]{width:100%;background:#0f1013;border:1px solid var(--line);color:var(--white);font:inherit;padding:2px 3px}
#cpanel textarea{width:100%;height:90px;background:#0f1013;color:var(--text);border:1px solid var(--line2);font:inherit;font-size:9px;margin-top:6px;display:none}
#cpanel .hint{color:var(--dim);font-size:9px;padding:6px 12px;border-top:1px solid var(--line)}
`;
document.head.appendChild(css);
const panel = document.createElement('div');
panel.id = 'cpanel';
const groups = [...new Set(PARAMS.map(p => p[5]))];
panel.innerHTML = `
  <div class="top"><b>画面参数</b>
    <button data-p="MINE" id="pMine">我的默认</button><button data-p="A">预设 A 暗底</button><button data-p="B">预设 B 亮线</button><button id="cSaveDef">保存为默认</button>
    <button id="cReset">重置当前预设</button><button id="cCopy">导出</button><button id="cImp">导入</button><button id="cClose">✕</button>
    <textarea id="cText" placeholder="粘贴导出的 JSON，再点一次「导入」应用"></textarea>
  </div>
  <div class="body">${groups.map((g, gi) => `<details ${gi < 2 ? 'open' : ''}><summary>${g}</summary>${
    PARAMS.filter(p => p[5] === g).map(p => `<div class="row" data-k="${p[0]}"><label title="${p[1]}">${p[1]}</label>
      <input type="range" min="${p[2]}" max="${p[3]}" step="${p[4]}"><input type="number" min="${p[2]}" max="${p[3]}" step="${p[4]}"></div>`).join('')
  }</details>`).join('')}</div>
  <div class="hint">C 键 开/关控制台 · F 键或双击画面 全屏 · M 键 开/关音乐 · 改动自动保存在本机浏览器</div>`;
document.body.appendChild(panel);
function syncPanel() {
  panel.querySelectorAll('.row').forEach(r => {
    const k = r.dataset.k, v = C[k];
    r.children[1].value = v; r.children[2].value = v;
    r.classList.toggle('chg', Math.abs(v - PRESETS[curPreset][k]) > 1e-9);
  });
  panel.querySelectorAll('[data-p]').forEach(b => b.classList.toggle('on', b.dataset.p === curPreset));
}
panel.addEventListener('input', e => {
  const r = e.target.closest('.row'); if (!r) return;
  const v = parseFloat(e.target.value); if (isNaN(v)) return;
  setParam(r.dataset.k, v); syncPanel();
});
panel.addEventListener('dblclick', e => e.stopPropagation());
panel.querySelectorAll('[data-p]').forEach(b => b.onclick = () => loadPreset(b.dataset.p));
panel.querySelector('#cReset').onclick = () => loadPreset(curPreset);
const pMine = panel.querySelector('#pMine');
pMine.hidden = !PRESETS.MINE;
panel.querySelector('#cSaveDef').onclick = e => {
  PRESETS.MINE = { ...C };
  try { localStorage.setItem(MINE_KEY, JSON.stringify(PRESETS.MINE)); } catch (err) {}
  curPreset = 'MINE'; pMine.hidden = false; saveCfg(); syncPanel();
  const b = e.currentTarget; b.textContent = '已保存 ✓'; setTimeout(() => b.textContent = '保存为默认', 1600);
};
panel.querySelector('#cClose').onclick = () => panel.classList.remove('open');
panel.querySelector('#cCopy').onclick = () => {
  const txt = JSON.stringify({ preset: curPreset, values: C }, null, 1);
  const ta = panel.querySelector('#cText'); ta.style.display = 'block'; ta.value = txt; ta.select();
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).catch(() => { try { document.execCommand('copy'); } catch (e) {} });
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'application/json' }));
  a.download = `paperlab-${curPreset}-settings.json`; a.click();
};
panel.querySelector('#cImp').onclick = () => {
  const ta = panel.querySelector('#cText');
  if (ta.style.display !== 'block' || !ta.value.trim().startsWith('{')) { ta.style.display = 'block'; ta.value = ''; ta.focus(); return; }
  try { const o = JSON.parse(ta.value); loadPreset(PRESETS[o.preset] ? o.preset : curPreset, o.values || o); ta.style.display = 'none'; }
  catch (e) { ta.value = '格式不对：' + e.message; }
};
document.querySelector('.console').addEventListener('click', () => { panel.classList.toggle('open'); syncPanel(); });
document.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'c' || e.key === 'C') { panel.classList.toggle('open'); syncPanel(); }
});

// ---- initial state: ?preset=a|b in the URL wins, otherwise the last saved session ----
(function initCfg() {
  const q = (new URLSearchParams(location.search).get('preset') || '').toUpperCase();
  const saved = lsGet();
  const name = PRESETS[q] ? q : saved && PRESETS[saved.preset] ? saved.preset : PRESETS.MINE ? 'MINE' : 'B';
  curPreset = name;
  const src = saved && saved.preset === name ? { ...PRESETS[name], ...saved.values } : PRESETS[name];
  for (const k in PRESETS[name]) setParam(k, src[k], true);
  if (location.hash === '#console') panel.classList.add('open');
  syncPanel();
})();


/* personal-halo 数据客户端与 HUD 启动（SSE /state //events /health）。 */
/* personal-halo: 镜头自动跟随状态机（滞回 + 最短停留，防 SSE 抖动抢镜）。
   idle 基线 0.18，单会话运行 0.58：在跟环降到 0.25 以下才让位，其他环 0.3 以上才抢镜。 */
window.haloFollowAgent = window.haloFollowAgent || null;
window.haloFollowKey = window.haloFollowKey || null;
const haloFollowState = { mode: 'tour', agent: null, live: false, lastSwitch: 0 };
setInterval(() => {
  if (document.hidden || !RINGS.length) return;
  let wantMode = 'tour', wantAgent = null, wantKey = null;
  if (window.haloAutoFollow) {
    let hot = null;
    for (const r of RINGS) {
      const cur = haloFollowState.mode === 'follow' && haloFollowState.agent === r.id;
      const th = cur ? 0.25 : 0.3;
      if (r.intensity > th && (!hot || r.intensity > hot.intensity)) hot = r;
    }
    if (hot) {
      // 多运行环轮换：同一目标停留超 7s 且存在其他运行环 → 顺位轮换（计时只随切换重置）
      if (haloFollowState.mode === 'follow' && hot.id === haloFollowState.agent
          && performance.now() - haloFollowState.lastSwitch > 11000) {   // 11s：含 ~6s 过渡，保证卡片净停留 ~5s
        const runAgents = RINGS.filter(r => r.intensity > 0.3).map(r => r.id);
        if (runAgents.length > 1) {
          const i = Math.max(0, runAgents.indexOf(haloFollowState.agent));
          hot = RINGS.find(r => r.id === runAgents[(i + 1) % runAgents.length]) || hot;
        }
      }
      wantMode = 'follow'; wantAgent = hot.id; wantKey = null;
    }
  } else if (window.haloFollowAgent && ringByAgent[window.haloFollowAgent] != null) {
    wantMode = 'follow'; wantAgent = window.haloFollowAgent; wantKey = window.haloFollowKey;
  }
  const wantLive = wantMode === 'follow' && !!cardShotFor(wantAgent, wantKey);
  if (wantMode === haloFollowState.mode && wantAgent === haloFollowState.agent && wantLive === haloFollowState.live) return;
  if (performance.now() - haloFollowState.lastSwitch < 4000) return;   // 最短停留 4s
  haloFollowState.mode = wantMode; haloFollowState.agent = wantAgent; haloFollowState.live = wantLive; haloFollowState.lastSwitch = performance.now();
  window.haloFollowAgent = wantAgent; window.haloFollowKey = wantKey;
  if (wantMode === 'follow' && typeof window.haloSelectSession === 'function') window.haloSelectSession(wantAgent, wantKey);
  buildShots.soft = true; buildShots(); agtWakeRender();
}, 2500);
// boot 由 halo-data.js 的 haloConnect() 完成


// personal-halo: cAdv/cDiff/cIdx 画布已齐备，保留 AGT 原生 resizePanels（不再覆盖为空）
// personal-halo: 动势预设（设置/菜单调用）——本机流畅按实测再调，不预承诺 FPS
window.haloPreset = function (name) {
  try {
    if (name === 'smooth' && PRESETS.MINE && !PRESETS.SMOOTH) {
      PRESETS.SMOOTH = { ...PRESETS.MINE, tempo: 1.8, runnerCount: 420, cometBurst: 5, cometPerBeat: 1.2, cometTrickle: 0.7 };
    }
    const q = name === 'smooth' ? 'low' : 'balanced';
    agtSettings.quality = q; saveScreenSettings();
    agtQuality = AGT_QUALITY[q] || agtQuality; agtCardDpr = agtQuality.cardDpr;
    Object.assign(agtAdaptive, { level: 0, fallback: false, startedAt: 0, workMs: 0, frames: 0, slowWindows: 0, goodWindows: 0, cpuPressureWindows: 0 });
    loadPreset(name === 'smooth' ? 'SMOOTH' : 'MINE');
    resizeAll();
    return true;
  } catch (e) { return false; }
};

// personal-halo: 内场层责任排查开关（?dbg=field,norunner,nocomet）——仅测试用
(function () {
  const dbg = new URLSearchParams(location.search).get('dbg') || '';
  if (!dbg) return;
  const M = { norunner: { runnerCount: 0 }, nocomet: { cometBurst: 0, cometPerBeat: 0, cometTrickle: 0 } };
  for (const part of dbg.split(',')) { const m = M[part]; if (m) for (const k in m) if (k in C) C[k] = m[k]; }
  window.__haloDbg = dbg;
})();
