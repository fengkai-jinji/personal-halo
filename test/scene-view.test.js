import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function view() {
  const context = vm.createContext({ window: { addEventListener() {} }, setInterval() {} });
  vm.runInContext(readFileSync(new URL('../public/halo-data.js', import.meta.url), 'utf8'), context);
  return context;
}
test('rate uses an available second source and never invents rates from cumulative tokens', () => {
  const c = view();
  const rate = vm.runInContext(`haloRatePresentation([
    {agent:'codex',state:'tool',tps:null,tokens:{output:100000}},
    {agent:'dsh',state:'streaming',tps:24.5,capabilities:['tps']}
  ])`, c);
  assert.match(rate.text, /DeepSeek.*24.5 tok\/s/);
  const absent = vm.runInContext(`haloRatePresentation([{agent:'codex',state:'streaming',tps:null,capabilities:['tokens']}])`, c);
  assert.match(absent.text, /未提供实时速率/);
  const idle = vm.runInContext(`haloRatePresentation([{agent:'codex',state:'idle',tps:24.5,capabilities:['tps']}])`, c);
  assert.doesNotMatch(idle.text, /24.5/);
});
test('all four source networks fit inside the innermost ring and keep stable source lanes', () => {
  const c = view();
  vm.runInContext(`var sampleNodes=['codex','dsh','zcode','workbuddy'].flatMap(source=>[
    {id:source,source,kind:'source'}, {id:source+':s',source,kind:'session',sessionId:source+':s'},
    {id:source+':t',source,kind:'tool',sessionId:source+':s'}]);`, c);
  const positions = vm.runInContext('haloInnerNodeLayout(sampleNodes, 260)', c);
  for (const p of positions.values()) {
    assert.ok(p.x > 0 && Math.hypot(p.x, p.y) < 260 - 20);
  }
  const reverse = vm.runInContext('haloInnerNodeLayout(sampleNodes.slice().reverse(),260)', c);
  for (const [id, p] of positions) assert.equal(reverse.get(id).y, p.y);
  const ys = ['codex','dsh','zcode','workbuddy'].map(id => positions.get(id).y);
  assert.equal(new Set(ys).size, 4);
});

test('unknown token object stays unknown while reported zero stays known per field', () => {
  const c = view();
  const unknown = vm.runInContext(`haloSessionShape({agent:'workbuddy',key:'workbuddy:x',state:'idle',tokens:{input:null,output:null,cacheRead:null}})`, c);
  assert.equal(unknown.inputTokens, null);
  assert.equal(unknown.outputTokens, null);
  assert.equal(unknown.hasTokens, false);
  const zero = vm.runInContext(`haloSessionShape({agent:'codex',key:'codex:x',state:'idle',tokens:{input:0,output:0,cacheRead:null}})`, c);
  assert.equal(zero.hasTokens, true);
  assert.equal(zero.outputTokens, 0);
  assert.equal(zero.cachedTokens, null);
});
