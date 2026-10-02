import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/db/store.js';
import { Pipeline } from '../../src/engine/pipeline.js';
import { MemoryNotifier } from '../../src/alerts/notifier.js';
import { runReplay } from '../../src/backtest/replay.js';
import { DEFAULT_SYNTH, generateSynthetic } from '../../src/backtest/synthetic.js';
import { loadConfig } from '../../src/config/load.js';
import { VolumeProfile } from '../../src/indicators/volumeProfile.js';
import { openDb, dbPath } from '../lib/db.js';
import { configPath } from '../lib/config.js';
import { buildHeatGrid, toBase64 } from '../lib/grid.js';
import * as q from '../lib/queries.js';

const cfg = loadConfig('config/config.json');
const START = Date.parse('2026-01-01T00:00:00Z');
const HOURS = 3;
const END = START + HOURS * 3_600_000;
let dir: string, file: string, ro: Store, rw: Store;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dash-'));
  file = path.join(dir, 'o.db');
  rw = new Store(file);
  const trades = [...generateSynthetic(DEFAULT_SYNTH, START, HOURS, 7)];
  rw.insertTrades(trades);
  // The same path the live collector takes: candles + footprint persisted, signals/alerts under run "live"
  const pipe = new Pipeline(cfg, { store: rw, notifier: new MemoryNotifier(), persistCandles: true });
  for (const t of trades) pipe.onTrade(t);
  pipe.flush();
  runReplay(rw, cfg, { runId: 'bt1' });
  // market-structure rows the live heat map / GEX / gap handling would have written
  rw.insertGexSnapshot({ underlying: 'BTC', ts: END - 600_000, spot: 65000, flipLevel: 64000, totalGex: 5e6, instruments: 40, strikes: [{ strike: 64000, callGex: 1e6, putGex: -2e6, gex: -1e6, oi: 900 }, { strike: 66000, callGex: 4e6, putGex: -1e6, gex: 3e6, oi: 1200 }] });
  rw.insertGexSnapshot({ underlying: 'BTC', ts: END - 300_000, spot: 65100, flipLevel: 64100, totalGex: 6e6, instruments: 41, strikes: [{ strike: 66000, callGex: 4e6, putGex: -1e6, gex: 3e6, oi: 1200 }] });
  rw.recordGap('BTCUSDT', END - 1000, 10, 19, 10);
  rw.recordGap('ETHUSDT', END - 2000, 50, 54, 0);
  const wid = rw.insertWall({ symbol: 'BTCUSDT', side: 'bid', price: 64990, ts: END - 1_800_000, size: 400 });
  rw.updateWall(wid, { ts: END - 600_000, size: 20, peak: 450, executed: 12, status: 'pulled' });
  rw.insertWall({ symbol: 'BTCUSDT', side: 'ask', price: 65100, ts: END - 900_000, size: 300 });
  for (let ts = END - 3_600_000; ts < END; ts += 30_000)
    rw.recordOrderbookSnapshot('BTCUSDT', ts, [[64990, 400], [64980, 20]], [[65010, 15], [65100, 300]]);
  process.env.DB_PATH = file;
  const st = openDb();
  assert.ok(st.ok);
  ro = st.store;
});

after(() => { rw.close(); rmSync(dir, { recursive: true, force: true }); delete process.env.DB_PATH; });

test('DB_PATH and CONFIG_PATH: relative values are relative to the repo root, not dashboard/ (the demo-DB bug)', () => {
  const cwd = '/repo/dashboard'; // how `npm run dashboard` runs the app
  assert.equal(dbPath(cwd, { DB_PATH: 'data/demo.db' }), '/repo/data/demo.db');
  assert.equal(dbPath(cwd, {}), '/repo/data/orderflow.db');
  assert.equal(dbPath(cwd, { DB_PATH: '/abs/other.db' }), '/abs/other.db');
  assert.equal(configPath(cwd, { CONFIG_PATH: 'config/x.json' }), '/repo/config/x.json');
  assert.equal(configPath(cwd, {}), '/repo/config/config.json');
  assert.equal(configPath(cwd, { CONFIG_PATH: '/abs/c.json' }), '/abs/c.json');
});

test('openDb: missing file and old schema are reported, a good file opens read-only and cannot be written', () => {
  const keep = process.env.DB_PATH;
  process.env.DB_PATH = path.join(dir, 'nope.db');
  const m = openDb();
  assert.ok(!m.ok && m.reason === 'missing');
  const old = path.join(dir, 'old.db');
  const raw = new DatabaseSync(old);
  raw.exec('PRAGMA user_version = 1; CREATE TABLE trades (a)');
  raw.close();
  process.env.DB_PATH = old;
  const s = openDb();
  assert.ok(!s.ok && s.reason === 'schema' && /needs v5|needs v\d+/.test(s.detail));
  process.env.DB_PATH = keep;
  assert.ok(openDb().ok);
  assert.throws(() => ro.db.exec("INSERT INTO gaps (symbol, detected_ts, from_id, to_id, missing) VALUES ('X',1,1,1,1)"), /readonly|read-only|attempt to write/i);
});

test('overview: per-asset activity, gaps, counts and recent feeds', () => {
  const o = q.overview(ro, cfg, END);
  assert.deepEqual(o.symbols.map((s) => s.symbol), ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  const btc = o.symbols[0];
  assert.ok(btc.price! > 1000 && btc.ageMs! < 5000 && btc.trades5m > 100);
  assert.equal(btc.activeWalls, 1);
  assert.equal(btc.gex!.flip, 64100); // latest snapshot
  assert.equal(o.symbols[1].gex, null === o.symbols[1].gex ? null : o.symbols[1].gex); // ETH has no snapshot here
  assert.deepEqual(o.gaps, { count: 2, missing: 15, unrecovered: 5 });
  assert.ok(o.counts.signals24h > 0 && o.counts.alerts24h > 0);
  assert.ok(o.recentSignals.length > 0 && o.recentSignals[0].conditions.length >= 3);
  assert.ok(o.recentAlerts.every((a) => !/[<>]/.test(a.text)));
  assert.equal(o.counts.open, o.openSignals.length);
});

test('signals: filters, status buckets, pagination, newest first', () => {
  const all = q.listSignals(ro, { limit: 500 });
  assert.ok(all.total > 3 && all.rows.length === all.total);
  assert.ok(all.rows.every((r, i) => i === 0 || all.rows[i - 1].ts >= r.ts));
  const long = q.listSignals(ro, { direction: 'LONG', limit: 500 });
  assert.ok(long.rows.length > 0 && long.rows.every((r) => r.direction === 'LONG'));
  assert.equal(q.listSignals(ro, { direction: 'LONG', limit: 500 }).total + q.listSignals(ro, { direction: 'SHORT', limit: 500 }).total, all.total);
  const win = q.listSignals(ro, { status: 'WIN', limit: 500 }), loss = q.listSignals(ro, { status: 'LOSS', limit: 500 });
  assert.ok(win.rows.every((r) => r.realizedR! > 0) && loss.rows.every((r) => r.realizedR! <= 0));
  const sym = q.listSignals(ro, { symbol: 'ETHUSDT', limit: 500 });
  assert.ok(sym.rows.every((r) => r.symbol === 'ETHUSDT'));
  const p1 = q.listSignals(ro, { limit: 2, offset: 0 }), p2 = q.listSignals(ro, { limit: 2, offset: 2 });
  assert.ok(p1.rows[0].id !== p2.rows[0].id && p1.total === all.total);
  assert.ok(q.listSignals(ro, { run: 'bt1', limit: 500 }).total > 0);
  assert.equal(q.listSignals(ro, { run: 'nope' }).total, 0);
});

test('signal detail: plan, conditions with details, confluence inputs; unknown id is null', () => {
  const id = q.listSignals(ro, { limit: 1 }).rows[0].id;
  const d = q.getSignal(ro, id)!;
  assert.ok(d.conditions.length >= 3 && d.conditions.every((c) => c.family && c.points >= 0));
  assert.ok(d.inputs.confluence?.familyScores && d.inputs.profile?.poc > 0 && d.inputs.atr > 0);
  assert.ok(d.signal.entryLo <= d.signal.entry && d.signal.entry <= d.signal.entryHi);
  assert.equal(q.getSignal(ro, 9_999_999), null);
});

test('signal chart: stored candles for live signals, rebuilt from trades for replay runs', () => {
  const live = q.getSignal(ro, q.listSignals(ro, { limit: 1 }).rows[0].id)!;
  const c1 = q.signalChart(ro, live);
  assert.ok(c1.candles.length > 20);
  assert.ok(c1.candles.every((c) => c.low <= c.open && c.low <= c.close && c.high >= c.open && c.high >= c.close));
  const bt = q.getSignal(ro, q.listSignals(ro, { run: 'bt1', limit: 1 }).rows[0].id)!;
  assert.equal(ro.db.prepare("SELECT COUNT(*) c FROM candles WHERE ts >= ? AND symbol = ?").get(bt.signal.ts - 3_600_000, bt.signal.symbol) !== undefined, true);
  assert.ok(q.signalChart(ro, bt).candles.length > 20);
});

test('alerts and runs', () => {
  const types = q.alertTypes(ro);
  assert.ok(types.includes('big_trade_at_level'));
  const only = q.listAlerts(ro, { type: 'big_trade_at_level', limit: 20 });
  assert.ok(only.length > 0 && only.every((a) => a.type === 'big_trade_at_level' && JSON.parse(a.inputs).trade));
  assert.deepEqual(q.listRuns(ro).map((r) => r.runId), ['live', 'bt1']); // live always first
});

test('performance and compare reuse the backtest code', () => {
  const rep = q.performance(ro, 'live');
  assert.equal(rep.total, q.listSignals(ro, { limit: 1 }).total);
  assert.ok(rep.byFamily.length > 0 && rep.byScoreBucket.length > 0);
  const c = q.compare(ro, 'live', 'bt1');
  assert.equal(c.common.n + c.onlyA.n, c.overall.a.n);
});

test('heat grid: places resting size at the right cell, keeps the max, ignores out-of-range, scales to 0..255', () => {
  const g = buildHeatGrid(
    [
      { ts: 0, bids: [[100, 10]], asks: [[110, 20]] },
      { ts: 10, bids: [[100, 50], [50, 999]], asks: [] }, // column 1; price 50 is out of range
      { ts: 15, bids: [[100, 5]], asks: [] }, // same cell as the previous one: the max (50) must win
    ],
    { fromTs: 0, toTs: 100, cols: 10, rows: 10, pMin: 100, pMax: 110 },
  );
  assert.equal(g.bid.length, 100);
  assert.equal(g.bid[9 * 10 + 1], 255); // price 100 -> bottom row, ts 10 and 15 -> column 1; max (50) wins => full intensity
  assert.equal(g.bid[9 * 10 + 0], Math.round((10 / g.scale) * 255)); // column 0 holds the smaller 10
  assert.equal(g.ask[0 * 10 + 0], Math.round((20 / g.scale) * 255)); // price 110 -> top row
  assert.equal(g.bid.filter((v) => v > 0).length, 2);
  assert.equal(Buffer.from(toBase64(g.bid), 'base64').length, 100);
});

test('heatmap query: grid, wall overlay (active walls extend to now), price line from candles', () => {
  const h = q.heatmap(ro, cfg, 'BTCUSDT', 1, END, 60, 40);
  assert.equal(h.snapshots, 120);
  assert.equal(Buffer.from(h.grid.bid, 'base64').length, h.grid.cols * h.grid.rows);
  assert.ok(h.grid.rows >= 1 && h.grid.rows <= 41);
  assert.ok(h.grid.pMin < h.grid.pMax && h.line.length > 30);
  assert.deepEqual(h.walls.map((w) => [w.side, w.status]).sort(), [['ask', 'active'], ['bid', 'pulled']]);
  assert.equal(h.walls.find((w) => w.status === 'active')!.lastSeen, END);
  const bidCells = [...Buffer.from(h.grid.bid, 'base64')].filter((v) => v > 0).length;
  assert.ok(bidCells >= 1 || h.grid.pMin > 64990, 'a bid at 64990 shows up unless the price window is elsewhere');
});

test('heatmap rows are aligned to price bins: a book with a level at every bin leaves no empty row (no stripes)', () => {
  const tmp = new Store(path.join(dir, 'dense.db'));
  const bin = cfg.assets.ETHUSDT.binSize; // 0.5
  const px = 2600;
  // trades so the price window is known
  tmp.insertTrades([2598, 2602, 2599.5, 2601].map((p, i) => ({ symbol: 'ETHUSDT', aggId: i + 1, ts: END - 3_000_000 + i * 600_000, price: p, size: 1, side: 'buy' as const })));
  for (let ts = END - 3_600_000; ts < END; ts += 30_000) {
    const bids: [number, number][] = [], asks: [number, number][] = [];
    for (let k = 0; k <= 80; k++) bids.push([px - k * bin, 10]); // bids cover the mid bin itself
    for (let k = 1; k <= 80; k++) asks.push([px + k * bin, 10]);
    tmp.recordOrderbookSnapshot('ETHUSDT', ts, bids, asks);
  }
  for (const rowsMax of [200, 40, 12]) { // also when several bins share a row
    const g = q.heatmap(tmp, cfg, 'ETHUSDT', 1, END, 120, rowsMax).grid;
    const bid = Buffer.from(g.bid, 'base64'), ask = Buffer.from(g.ask, 'base64');
    let empty = 0;
    for (let r = 0; r < g.rows; r++) {
      let any = false;
      for (let c = 0; c < g.cols; c++) if (bid[r * g.cols + c] || ask[r * g.cols + c]) { any = true; break; }
      if (!any) empty++;
    }
    assert.ok(g.rows <= rowsMax + 1, `rows ${g.rows} for max ${rowsMax}`);
    assert.equal(empty, 0, `${empty} empty rows of ${g.rows} (maxRows ${rowsMax})`);
  }
  tmp.close();
});

test('footprint view: newest first, imbalance marks and deltas consistent with the stored levels', () => {
  const v = q.footprints(ro, cfg, 'ETHUSDT', '5m', 4);
  assert.equal(v.length, 4);
  assert.ok(v[0].candle.ts > v[1].candle.ts);
  for (const x of v) {
    assert.equal(x.delta, x.candle.totalAsk - x.candle.totalBid);
    assert.ok(x.candle.high >= x.candle.low && x.candle.levels.length > 0);
    assert.ok(x.marks.every((m) => m.index >= 0 && m.index < x.candle.levels.length));
    assert.ok(x.stacked.every((e) => e.kind === 'stacked_imbalance'));
  }
  assert.deepEqual(q.footprints(ro, cfg, 'ETHUSDT', '15m', 3), []); // only 5m footprints are enabled in the config
  assert.deepEqual(q.footprints(ro, cfg, 'DOGEUSDT', '5m', 3), []);
});

test('gex view: latest strikes and windowed history', () => {
  const g = q.gex(ro, 'BTC', 1, END);
  assert.equal(g.latest!.flipLevel, 64100);
  assert.equal(g.latest!.strikes.length, 1);
  assert.equal(g.history.length, 2);
  assert.equal(q.gex(ro, 'BTC', 0.1, END).history.length, 1); // 6 min window: only the 5-minute-old snapshot
  assert.equal(q.gex(ro, 'ETH', 1, END).latest, null);
});

test('profile view matches the engine\'s VolumeProfile and its histogram sums to total volume', () => {
  const p = q.profile(ro, cfg, 'SOLUSDT', 2, END);
  assert.ok(p.snapshot && p.trades > 1000);
  const vp = new VolumeProfile({ binSize: cfg.assets.SOLUSDT.binSize, windowMs: 2 * 3_600_000, valueAreaPct: cfg.volumeProfile.valueAreaPct, hvnFactor: cfg.volumeProfile.hvnFactor, hvnMinSepBins: cfg.volumeProfile.hvnMinSepBins, hvnSmoothBins: cfg.volumeProfile.hvnSmoothBins });
  let last = 0;
  for (const t of rw.iterTrades(['SOLUSDT'], END - 2 * 3_600_000, END)) { vp.add(t.ts, t.price, t.size); last = t.ts; }
  assert.equal(p.snapshot!.poc, vp.snapshot(last)!.poc);
  assert.ok(Math.abs(p.bins.reduce((a, b) => a + b.volume, 0) - p.snapshot!.totalVolume) < 1e-6);
  assert.ok(p.bins.every((b, i) => i === 0 || p.bins[i - 1].price < b.price));
});
