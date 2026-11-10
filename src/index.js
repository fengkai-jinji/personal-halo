#!/usr/bin/env node
// Derived from agent-halo (commit 4a22a69c6ad9) collector/src/index.js under
// PolyForm Noncommercial 1.0.0. Changes for personal-halo: banner text.
import { loadConfig } from './config.js';
import adapters from './adapters/index.js';
import { Store, version } from './store.js';
import { Watcher } from './watch.js';
import { startServer } from './server.js';
import { prepareReplay } from './replay.js';

async function main() {
  const config = loadConfig();
  if (config.help) {
    console.log('collector --port N --config PATH --privacy titles|none --detail basic|full --only IDS --dump --replay DIR --speed N --selftest-perf SEC --verbose');
    return;
  }
  const replay = config.replay ? await prepareReplay(config.replay, config.speed, adapters) : null;
  if (replay) {
    config.only = replay.id;
    config.adapters = { [replay.id]: { enabled: true, roots: [replay.root] } };
  }
  const store = new Store(config);
  const watcher = new Watcher(adapters, store, config);
  await watcher.start(!config.dump);
  if (config.dump) {
    console.log(JSON.stringify(store.snapshot(), null, 2));
    await watcher.close(); store.close(); await replay?.close(); return;
  }
  store.start();
  let server;
  try {
    server = await startServer(store, watcher, config.port);
  } catch (error) {
    await watcher.close(); store.close(); await replay?.close();
    console.error(error.code === 'EADDRINUSE'
      ? `端口 ${config.port} 已被占用，采集程序可能已在运行`
      : `监听端口 ${config.port} 失败：${error.code ?? error.name}`);
    process.exitCode = 1;
    return;
  }
  console.error(`personal-halo collector ${version} · http://127.0.0.1:${server.port} · ${watcher.health().map(a => a.id + (a.status === 'ok' ? '✓' : '–')).join(' ')}`);
  replay?.start();
  const close = async () => { await watcher.close(); store.close(); await server.close(); await replay?.close(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  if (config.perfSec) {
    const cpu = process.cpuUsage();
    const start = performance.now();
    const initialRSS = process.memoryUsage.rss();
    let peak = initialRSS;
    const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 1000);
    await new Promise(resolve => setTimeout(resolve, config.perfSec * 1000));
    clearInterval(sample);
    const used = process.cpuUsage(cpu);
    console.log(JSON.stringify({ seconds: config.perfSec, cpuPercent: (used.user + used.system) / ((performance.now() - start) * 10), rssPeakMB: peak / 1024 / 1024,
      rssStartMB: initialRSS / 1024 / 1024, rssEndMB: process.memoryUsage.rss() / 1024 / 1024 }));
    await close();
  }
}

main().catch(error => { console.error(error.code ?? error.name); process.exitCode = 1; });
