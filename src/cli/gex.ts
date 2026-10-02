import { loadConfig } from '../config/load.js';
import { Store } from '../db/store.js';
import { fmtPrice, fmtTime } from '../core/format.js';
import { fetchBookSummary } from '../collector/gex.js';
import { computeGex } from '../indicators/gex.js';
import type { GexSnapshot } from '../core/types.js';
import { cli } from './args.js';

// Shows the latest stored GEX snapshot, or with --live fetches Deribit right now (stores nothing) —
// handy to verify connectivity and sanity-check the numbers.
const a = cli({ db: { type: 'string' }, symbol: { type: 'string' }, live: { type: 'boolean' }, top: { type: 'string' } });
const cfg = loadConfig();
const symbol = (a.symbol as string) ?? Object.keys(cfg.gex.underlyings)[0];
const cur = cfg.gex.underlyings[symbol];
if (!cur) throw new Error(`${symbol} has no GEX mapping (only ${Object.keys(cfg.gex.underlyings).join(', ')} — SOL options are too thin)`);

let snap: GexSnapshot | null;
if (a.live) {
  try {
    const rows = await fetchBookSummary(cfg.gex.baseUrl, cur);
    snap = computeGex(cur, rows, Date.now(), cfg.gex);
    console.log(`live fetch: ${rows.length} option rows from Deribit`);
  } catch (e) {
    console.error(`Deribit fetch failed: ${(e as Error).message}`);
    process.exit(1);
  }
} else {
  const store = new Store((a.db as string) ?? cfg.dbPath);
  snap = store.latestGexBefore(cur, Date.now());
  if (snap) snap = store.loadGexSnapshots([cur], snap.ts, snap.ts, true)[0];
}
if (!snap) {
  console.log('no GEX snapshot available');
  process.exit(0);
}
const bn = (v: number) => `${(v / 1e6).toFixed(1)}M`;
console.log(`${cur} GEX @ ${fmtTime(snap.ts)} · spot ${fmtPrice(snap.spot)} · ${snap.instruments} options`);
console.log(`net GEX ${bn(snap.totalGex)} per 1% move (${snap.totalGex >= 0 ? 'positive gamma: dealers dampen moves' : 'negative gamma: dealers amplify moves'})`);
console.log(snap.flipLevel == null ? 'flip level: none within the search range' : `flip level: ${fmtPrice(snap.flipLevel)} (${(((snap.spot - snap.flipLevel) / snap.flipLevel) * 100).toFixed(2)}% ${snap.spot >= snap.flipLevel ? 'above' : 'below'} it)`);
const top = [...snap.strikes].sort((x, y) => Math.abs(y.gex) - Math.abs(x.gex)).slice(0, Number(a.top ?? 8));
if (top.length) {
  console.log('\n   strike        net GEX      calls       puts       OI');
  for (const s of top.sort((x, y) => y.strike - x.strike))
    console.log(`${fmtPrice(s.strike).padStart(9)} ${bn(s.gex).padStart(12)} ${bn(s.callGex).padStart(10)} ${bn(s.putGex).padStart(10)} ${s.oi.toFixed(0).padStart(8)}`);
}
