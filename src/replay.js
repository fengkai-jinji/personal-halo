import { mkdtemp, readdir, readFile, mkdir, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseJSON } from './util/jsonl.js';

export async function prepareReplay(directory, speed, adapters) {
  const id = path.basename(path.resolve(directory));
  const adapter = adapters.find(a => a.id === id);
  if (!adapter) throw new Error('ReplayAdapter');
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-halo-replay-'));
  const events = [];
  for (const name of await readdir(directory)) if (name.endsWith('.jsonl') && adapter.match(name)) {
    for (const line of (await readFile(path.join(directory, name), { encoding: 'utf8', flag: 'r' })).split('\n').filter(Boolean)) {
      const record = parseJSON(line, () => {});
      const at = Date.parse(record?.timestamp) || record?.time || record?.createdAt || 0;
      events.push({ name, at, record, line });
    }
  }
  if (!events.length) { await rm(root, { recursive: true }); throw new Error('ReplayEmpty'); }
  events.sort((a, b) => a.at - b.at);
  let timer;
  let stopped = false;
  let pending = Promise.resolve();
  return {
    id, root,
    start() {
      const first = events[0].at;
      const start = Date.now() + 500;
      let index = 0;
      const next = () => {
        if (stopped || index === events.length) return;
        const event = events[index++];
        const target = start + (event.at - first) / speed;
        timer = setTimeout(() => {
          pending = (async () => {
            const r = event.record;
            if (r?.timestamp) r.timestamp = new Date(target).toISOString();
            if (r?.time !== undefined) r.time = target;
            if (r?.createdAt !== undefined) r.createdAt = target;
            await mkdir(path.dirname(path.join(root, event.name)), { recursive: true });
            await appendFile(path.join(root, event.name), (r ? JSON.stringify(r) : event.line) + '\n');
          })();
          pending.then(next, () => { console.error('ReplayWrite'); });
        }, Math.max(0, target - Date.now()));
      };
      next();
    },
    async close() {
      stopped = true; clearTimeout(timer); await pending;
      await rm(root, { recursive: true, force: true });
    },
  };
}
