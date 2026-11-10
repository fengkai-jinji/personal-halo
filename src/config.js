// Derived from agent-halo (commit 4a22a69c6ad9) collector/src/config.js under
// PolyForm Noncommercial 1.0.0. Changes for personal-halo: default port 47830
// and the personal-halo config directory.
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export const defaults = {
  port: 47830, privacy: 'titles', detail: 'basic', visibleIdleMin: 600,   // 10h：近期会话可见窗口（历史会话仍可见；在线判定另有独立口径）
  maxSessions: 12, staleSec: 90, toolStaleSec: 900, adapters: {}, speed: 1,
};

export function loadConfig(argv = process.argv.slice(2)) {
  const cli = {};
  const names = { '--port': 'port', '--config': 'config', '--privacy': 'privacy',
    '--detail': 'detail', '--only': 'only', '--replay': 'replay', '--speed': 'speed',
    '--selftest-perf': 'perfSec' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (['--dump','--verbose','--help'].includes(flag)) cli[flag.slice(2)] = true;
    else if (names[flag]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('ConfigArgument');
      cli[names[flag]] = argv[++i];
    } else throw new Error('ConfigArgument');
  }
  const appData = process.env.APPDATA ?? path.join(os.homedir(), '.config');
  const file = cli.config ?? [path.resolve('config.json'), path.join(appData, 'personal-halo', 'config.json')].find(existsSync);
  const saved = file ? JSON.parse(readFileSync(file, { encoding: 'utf8', flag: 'r' })) : {};
  const config = { ...defaults, ...saved, ...cli };
  for (const key of ['port','visibleIdleMin','maxSessions','staleSec','toolStaleSec','speed','perfSec']) {
    if (config[key] !== undefined) config[key] = Number(config[key]);
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535 ||
      !['titles','none'].includes(config.privacy) || !['basic','full'].includes(config.detail) ||
      !['visibleIdleMin','maxSessions','staleSec','toolStaleSec','speed'].every(k => config[k] > 0) ||
      (config.perfSec !== undefined && !(config.perfSec > 0))) throw new Error('ConfigValue');
  return config;
}
