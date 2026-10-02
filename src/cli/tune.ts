import { loadConfig } from '../config/load.js';
import { Store } from '../db/store.js';
import { analyze, formatTune } from '../tune/analyze.js';
import { cli } from './args.js';

// Measures your collected data against the current thresholds (big trades, walls, alert volume) and suggests values.
//   npm run tune                  analyse up to the last 24 hours
//   npm run tune -- --hours 6 --big 20 --json
const a = cli({ db: { type: 'string' }, hours: { type: 'string' }, big: { type: 'string' }, walls: { type: 'string' }, json: { type: 'boolean' } });
const cfg = loadConfig();
const store = new Store((a.db as string) ?? cfg.dbPath, 'live', { readOnly: true });
const report = analyze(store, cfg, {
  hours: Number(a.hours ?? 24),
  targets: { ...(a.big ? { bigPerHour: Number(a.big) } : {}), ...(a.walls ? { steadyWallsPerHour: Number(a.walls) } : {}) },
});
console.log(a.json ? JSON.stringify(report, null, 2) : formatTune(report));
