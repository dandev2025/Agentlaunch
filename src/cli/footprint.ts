import { loadConfig } from '../config/load.js';
import { Store } from '../db/store.js';
import { fmtPrice, fmtTime } from '../core/format.js';
import { TF_MS, type FootprintCandle, type Timeframe } from '../core/types.js';
import { detectStackedImbalance, FootprintBuilder, imbalanceMarks } from '../indicators/footprint.js';
import { cli, parseTime } from './args.js';

// Prints footprint ladders (bid x ask per level) from stored trades, marking diagonal imbalances.
const a = cli({ db: { type: 'string' }, symbol: { type: 'string' }, tf: { type: 'string' }, last: { type: 'string' }, at: { type: 'string' } });
const cfg = loadConfig();
const store = new Store((a.db as string) ?? cfg.dbPath);
const symbol = (a.symbol as string) ?? Object.keys(cfg.assets)[0];
const tf = ((a.tf as string) ?? '5m') as Timeframe;
if (!(tf in TF_MS)) throw new Error(`unknown timeframe ${tf}`);
const last = Number(a.last ?? 1);
const range = store.tradeRange([symbol]);
if (!range) throw new Error(`no stored trades for ${symbol}`);
const end = parseTime(a.at) ?? range.max;
const from = end - (last + 1) * TF_MS[tf];

const fb = new FootprintBuilder(symbol, tf, cfg.assets[symbol].footprintBin);
const candles: FootprintCandle[] = [];
for (const t of store.iterTrades([symbol], from, end)) {
  const c = fb.add(t);
  if (c) candles.push(c);
}
for (const fc of candles.slice(-last)) {
  const marks = imbalanceMarks(fc, cfg.footprint);
  const stacked = detectStackedImbalance(fc, cfg.footprint);
  console.log(`\n${symbol} ${tf} ${fmtTime(fc.ts)}  O ${fmtPrice(fc.open)} H ${fmtPrice(fc.high)} L ${fmtPrice(fc.low)} C ${fmtPrice(fc.close)}  delta ${(fc.totalAsk - fc.totalBid).toFixed(2)}`);
  console.log('   price      bid x ask');
  [...fc.levels].reverse().forEach((l, ri) => {
    const i = fc.levels.length - 1 - ri;
    const m = marks.filter((x) => x.index === i).map((x) => (x.side === 'buy' ? 'B▲' : 'S▼')).join('');
    console.log(`${fmtPrice(l.price).padStart(10)}  ${l.bid.toFixed(2).padStart(9)} x ${l.ask.toFixed(2).padEnd(9)} ${m}`);
  });
  for (const s of stacked) console.log(`  → stacked ${(s.detail as any).side} imbalance, ${(s.detail as any).levels} levels ${fmtPrice(s.lo)}–${fmtPrice(s.hi)}`);
}
