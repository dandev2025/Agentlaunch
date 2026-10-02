import { rmSync } from 'node:fs';
import { loadConfig } from '../config/load.js';
import { Store } from '../db/store.js';
import { MemoryNotifier } from '../alerts/notifier.js';
import { Pipeline } from '../engine/pipeline.js';
import { DEFAULT_SYNTH, generateSynthetic, mulberry32 } from '../backtest/synthetic.js';
import { runReplay } from '../backtest/replay.js';
import { cli } from './args.js';

// Builds a COMPLETE demo database (trades, candles, footprint, signals, alerts, order-book snapshots, walls, GEX)
// from SYNTHETIC data so the dashboard has something to show. Everything in it is fake. Writes to its own file.
//   npm run seed-demo            ->  data/demo.db   (then:  DB_PATH=data/demo.db npm run dashboard)
const a = cli({ db: { type: 'string' }, hours: { type: 'string' } });
const cfg = loadConfig();
const path = (a.db as string) ?? 'data/demo.db';
const hours = Number(a.hours ?? 6);
for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
const store = new Store(path);

const end = Date.now() - (Date.now() % 60_000);
const start = end - hours * 3_600_000;
const assets = DEFAULT_SYNTH.filter((s) => cfg.assets[s.symbol]?.enabled);
const trades = [...generateSynthetic(assets, start, hours, 11)];
store.insertTrades(trades);

// live-style run: candles + footprint persisted, signals/alerts under run "live"
const pipe = new Pipeline(cfg, { store, notifier: new MemoryNotifier(), persistCandles: true });
for (const t of trades) pipe.onTrade(t);
pipe.flush();
// a backtest run alongside, so the Performance/compare pages have two runs
runReplay(store, cfg, { runId: 'demo-bt' });
runReplay(store, { ...cfg, signals: { ...cfg.signals, confluence: { ...cfg.signals.confluence, enabled: false } } }, { runId: 'demo-bt-flat' });

// price per minute per symbol, for synthetic books
const px = new Map<string, Map<number, number>>();
for (const t of trades) {
  const m = px.get(t.symbol) ?? new Map();
  m.set(Math.floor(t.ts / 60_000), t.price);
  px.set(t.symbol, m);
}
const priceAt = (sym: string, ts: number): number => {
  const m = px.get(sym)!;
  for (let k = Math.floor(ts / 60_000); k > Math.floor(start / 60_000) - 5; k--) if (m.has(k)) return m.get(k)!;
  return [...m.values()][0];
};

const rnd = mulberry32(5);
for (const sym of Object.keys(cfg.assets)) {
  const bin = cfg.assets[sym].binSize, minQty = cfg.assets[sym].wallMinQty;
  // wall lifecycles: appear, live 5-40 min, end pulled / eaten
  const walls: { id: number; side: 'bid' | 'ask'; price: number; from: number; to: number; size: number; status: string }[] = [];
  for (let t = start + 600_000; t < end - 600_000; t += 600_000 + rnd() * 900_000) {
    const side = rnd() < 0.5 ? 'bid' : 'ask';
    const mid = priceAt(sym, t);
    const price = Math.round((mid * (1 + (side === 'bid' ? -1 : 1) * (0.0008 + rnd() * 0.004))) / bin) * bin;
    const to = Math.min(end, t + (5 + rnd() * 35) * 60_000);
    const status = to >= end ? 'active' : rnd() < 0.55 ? 'pulled' : 'eaten';
    const size = minQty * (1.5 + rnd() * 3);
    const id = store.insertWall({ symbol: sym, side, price, ts: t, size });
    store.recordWallEvent(id, t, 'added', size);
    store.updateWall(id, { ts: to, size: status === 'active' ? size : size * 0.05, peak: size, executed: status === 'eaten' ? size * 0.7 : status === 'pulled' ? size * 0.02 : 0, status: status === 'active' ? undefined : status });
    if (status !== 'active') store.recordWallEvent(id, to, status as 'pulled' | 'eaten', size * 0.05);
    walls.push({ id, side, price, from: t, to, size, status });
  }
  // book snapshots every 30s: noisy resting size that thickens a bit away from price, plus the live walls
  for (let ts = start; ts <= end; ts += 30_000) {
    const mid = priceAt(sym, ts), base = minQty / 25;
    const bids: [number, number][] = [], asks: [number, number][] = [];
    for (let k = 1; k <= 90; k++) {
      const sz = base * (0.4 + rnd() * 1.2) * (1 + k / 60);
      bids.push([Math.round((mid - k * bin) / bin) * bin, +sz.toFixed(3)]);
      asks.push([Math.round((mid + k * bin) / bin) * bin, +(base * (0.4 + rnd() * 1.2) * (1 + k / 60)).toFixed(3)]);
    }
    for (const w of walls) {
      if (ts < w.from || ts > w.to) continue;
      const side = w.side === 'bid' ? bids : asks;
      const lvl = side.find((l) => l[0] === w.price);
      if (lvl) lvl[1] = +w.size.toFixed(3); else side.push([w.price, +w.size.toFixed(3)]);
    }
    store.recordOrderbookSnapshot(sym, ts, bids.sort((x, y) => y[0] - x[0]), asks.sort((x, y) => x[0] - y[0]));
  }
}

// GEX snapshots (BTC/ETH only) every 5 minutes: spot-following flip level slightly below price
for (const [sym, cur] of Object.entries(cfg.gex.underlyings)) {
  for (let ts = start; ts <= end; ts += 300_000) {
    const spot = priceAt(sym, ts);
    const flip = spot * (0.985 + 0.01 * Math.sin(ts / 3_600_000));
    const strikes = Array.from({ length: 21 }, (_, i) => {
      const k = Math.round((spot * (0.9 + i * 0.01)) / (spot > 10_000 ? 500 : 25)) * (spot > 10_000 ? 500 : 25);
      const call = (spot > 10_000 ? 9e6 : 3e6) * Math.exp(-Math.pow((k - spot * 1.03) / (spot * 0.04), 2)) * (0.6 + rnd() * 0.8);
      const put = -(spot > 10_000 ? 11e6 : 3.5e6) * Math.exp(-Math.pow((k - spot * 0.97) / (spot * 0.04), 2)) * (0.6 + rnd() * 0.8);
      return { strike: k, callGex: call, putGex: put, gex: call + put, oi: Math.round(Math.abs(call + put) / 5000) };
    });
    store.insertGexSnapshot({ underlying: cur, ts, spot, flipLevel: flip, totalGex: strikes.reduce((s, x) => s + x.gex, 0), strikes, instruments: 180 });
  }
}
// a couple of gap records so the overview's gap card has something to show
store.recordGap('BTCUSDT', end - 3_600_000, 1000, 1011, 12);
store.recordGap('SOLUSDT', end - 1_800_000, 2000, 2003, 0);
store.close();
console.log(`Demo database written to ${path} (${trades.length} SYNTHETIC trades, ${hours}h). Not real market data.`);
console.log(`View it:  DB_PATH=${path} npm run dashboard`);
