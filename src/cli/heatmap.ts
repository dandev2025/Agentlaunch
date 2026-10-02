import { loadConfig } from '../config/load.js';
import { Store } from '../db/store.js';
import { fmtPrice, fmtTime } from '../core/format.js';
import { cli } from './args.js';

// Lists recorded resting walls (added / pulled / eaten) from the database. The visual heat map comes with the dashboard.
const a = cli({ db: { type: 'string' }, symbol: { type: 'string' }, hours: { type: 'string' }, status: { type: 'string' }, limit: { type: 'string' } });
const cfg = loadConfig();
const store = new Store((a.db as string) ?? cfg.dbPath);
const symbol = (a.symbol as string) ?? Object.keys(cfg.assets)[0];
const to = Date.now();
const from = to - Number(a.hours ?? 6) * 3_600_000;
const limit = Number(a.limit ?? 40);

let rows = store.loadWalls([symbol], from, to);
if (typeof a.status === 'string') rows = rows.filter((r) => r.status === a.status);
const counts: Record<string, number> = {};
for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
console.log(`${symbol}: ${rows.length} walls in the last ${a.hours ?? 6}h  ${JSON.stringify(counts)}`);
console.log('first seen            side   price        peak       last      lived   traded  status');
for (const r of rows.slice(-limit)) {
  console.log(
    `${fmtTime(r.firstSeen)}  ${r.side.padEnd(4)} ${fmtPrice(r.price).padStart(10)} ${r.peak.toFixed(1).padStart(10)} ${r.lastSize.toFixed(1).padStart(10)} ` +
      `${(Math.round((r.lastSeen - r.firstSeen) / 1000) + 's').padStart(8)} ${r.executed.toFixed(1).padStart(8)}  ${r.status}`,
  );
}
