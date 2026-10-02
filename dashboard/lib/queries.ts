import type { Store } from '../../src/db/store.js';
import type { Config } from '../../src/config/types.js';
import { LIVE_RUN } from '../../src/db/store.js';
import { buildReport, type Report } from '../../src/backtest/report.js';
import { compareRuns, type Comparison } from '../../src/backtest/compare.js';
import { CandleBuilder } from '../../src/indicators/candles.js';
import { VolumeProfile } from '../../src/indicators/volumeProfile.js';
import { detectAbsorption, detectStackedImbalance, imbalanceMarks, type ImbalanceMark } from '../../src/indicators/footprint.js';
import type { Candle, FootprintCandle, FootprintEvent, FootprintLevel, ProfileSnapshot, Timeframe } from '../../src/core/types.js';
import { TF_MS } from '../../src/core/types.js';
import { buildHeatGrid, toBase64, type BookSnap, type HeatGrid } from './grid.js';
import { stripHtml } from './format.js';

type Row = Record<string, any>;
const all = (s: Store, sql: string, ...a: any[]) => s.db.prepare(sql).all(...a) as Row[];
const one = (s: Store, sql: string, ...a: any[]) => s.db.prepare(sql).get(...a) as Row | undefined;
const DAY = 86_400_000;

// ---- shared shapes -----------------------------------------------------------------
export interface SignalListRow {
  id: number;
  runId: string;
  ts: number;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  score: number;
  entry: number;
  stop: number;
  t1: number;
  t2: number;
  rr: number;
  status: string;
  outcome: string | null;
  realizedR: number | null;
  mfeR: number;
  maeR: number;
  conditions: string[];
}

function toSignalRows(s: Store, rows: Row[]): SignalListRow[] {
  const ids = rows.map((r) => r.id);
  const conds = new Map<number, string[]>();
  if (ids.length) {
    for (const c of all(s, `SELECT signal_id, key FROM signal_conditions WHERE signal_id IN (${ids.map(() => '?').join(',')}) ORDER BY key`, ...ids))
      conds.set(c.signal_id, [...(conds.get(c.signal_id) ?? []), c.key]);
  }
  return rows.map((r) => ({
    id: r.id, runId: r.run_id, ts: r.ts, symbol: r.symbol, direction: r.direction, score: r.score, entry: r.entry, stop: r.stop,
    t1: r.t1, t2: r.t2, rr: r.rr, status: r.status, outcome: r.outcome, realizedR: r.realized_r,
    mfeR: r.max_favorable_r, maeR: r.max_adverse_r, conditions: conds.get(r.id) ?? [],
  }));
}

export interface AlertRow {
  id: number;
  runId: string;
  ts: number;
  symbol: string;
  type: string;
  text: string;
  inputs: string;
}

// ---- overview ----------------------------------------------------------------------
export interface OverviewData {
  now: number;
  symbols: {
    symbol: string; lastTs: number | null; price: number | null; ageMs: number | null; trades5m: number; bigTrades24h: number;
    openSignals: number; activeWalls: number; gex: { flip: number | null; ageMs: number; spot: number } | null;
  }[];
  gaps: { count: number; missing: number; unrecovered: number };
  counts: { alerts24h: number; signals24h: number; open: number };
  openSignals: SignalListRow[];
  recentSignals: SignalListRow[];
  recentAlerts: AlertRow[];
}

export function overview(s: Store, cfg: Config, now = Date.now()): OverviewData {
  const gexMap = cfg.gex.underlyings as Record<string, string>;
  const symbols = Object.entries(cfg.assets).filter(([, a]) => a.enabled).map(([symbol]) => {
    const last = one(s, 'SELECT ts, price FROM trades WHERE symbol = ? ORDER BY ts DESC LIMIT 1', symbol);
    const cur = gexMap[symbol];
    const g = cur ? one(s, 'SELECT ts, spot, flip_level FROM gex_snapshots WHERE underlying = ? ORDER BY ts DESC LIMIT 1', cur) : undefined;
    return {
      symbol,
      lastTs: last?.ts ?? null,
      price: last?.price ?? null,
      ageMs: last ? now - last.ts : null,
      trades5m: one(s, 'SELECT COUNT(*) c FROM trades WHERE symbol = ? AND ts >= ?', symbol, now - 300_000)!.c,
      bigTrades24h: one(s, 'SELECT COUNT(*) c FROM big_trades WHERE run_id = ? AND symbol = ? AND ts >= ?', LIVE_RUN, symbol, now - DAY)!.c,
      openSignals: one(s, "SELECT COUNT(*) c FROM signals WHERE run_id = ? AND symbol = ? AND status = 'OPEN'", LIVE_RUN, symbol)!.c,
      activeWalls: one(s, "SELECT COUNT(*) c FROM book_walls WHERE symbol = ? AND status = 'active'", symbol)!.c,
      gex: g ? { flip: g.flip_level, ageMs: now - g.ts, spot: g.spot } : null,
    };
  });
  const gaps = one(s, 'SELECT COUNT(*) c, COALESCE(SUM(missing),0) m, COALESCE(SUM(missing - recovered),0) u FROM gaps WHERE detected_ts >= ?', now - DAY)!;
  return {
    now, symbols,
    gaps: { count: gaps.c, missing: gaps.m, unrecovered: Math.max(0, gaps.u) },
    counts: {
      alerts24h: one(s, 'SELECT COUNT(*) c FROM alerts WHERE run_id = ? AND ts >= ?', LIVE_RUN, now - DAY)!.c,
      signals24h: one(s, 'SELECT COUNT(*) c FROM signals WHERE run_id = ? AND ts >= ?', LIVE_RUN, now - DAY)!.c,
      open: one(s, "SELECT COUNT(*) c FROM signals WHERE run_id = ? AND status = 'OPEN'", LIVE_RUN)!.c,
    },
    openSignals: toSignalRows(s, all(s, "SELECT * FROM signals WHERE run_id = ? AND status = 'OPEN' ORDER BY ts DESC LIMIT 20", LIVE_RUN)),
    recentSignals: toSignalRows(s, all(s, 'SELECT * FROM signals WHERE run_id = ? ORDER BY ts DESC, id DESC LIMIT 10', LIVE_RUN)),
    recentAlerts: listAlerts(s, { run: LIVE_RUN, limit: 10 }),
  };
}

// ---- runs / signals / alerts ---------------------------------------------------------
export interface RunInfo { runId: string; signals: number; closed: number; fromTs: number; toTs: number }

export function listRuns(s: Store): RunInfo[] {
  return all(s, "SELECT run_id, COUNT(*) n, SUM(status = 'CLOSED') closed, MIN(ts) a, MAX(ts) b FROM signals GROUP BY run_id ORDER BY (run_id = 'live') DESC, MAX(ts) DESC")
    .map((r) => ({ runId: r.run_id, signals: r.n, closed: r.closed ?? 0, fromTs: r.a, toTs: r.b }));
}

export interface SignalFilter { run?: string; symbol?: string; direction?: string; status?: string; limit?: number; offset?: number }

export function listSignals(s: Store, f: SignalFilter = {}): { rows: SignalListRow[]; total: number } {
  const where: string[] = ['run_id = ?'];
  const args: any[] = [f.run ?? LIVE_RUN];
  if (f.symbol) { where.push('symbol = ?'); args.push(f.symbol); }
  if (f.direction === 'LONG' || f.direction === 'SHORT') { where.push('direction = ?'); args.push(f.direction); }
  if (f.status === 'OPEN' || f.status === 'CLOSED') { where.push('status = ?'); args.push(f.status); }
  else if (f.status === 'WIN') where.push('realized_r > 0');
  else if (f.status === 'LOSS') where.push('realized_r <= 0');
  const w = where.join(' AND ');
  const total = one(s, `SELECT COUNT(*) c FROM signals WHERE ${w}`, ...args)!.c;
  const rows = all(s, `SELECT * FROM signals WHERE ${w} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`, ...args, f.limit ?? 50, f.offset ?? 0);
  return { rows: toSignalRows(s, rows), total };
}

export interface SignalDetail {
  signal: SignalListRow & { entryLo: number; entryHi: number; rrT1: number; rrT2: number; atr: number; t1Ts: number | null; t2Ts: number | null; stopTs: number | null; closedTs: number | null; maxFavorable: number; maxAdverse: number };
  conditions: { key: string; family: string; points: number; detail: unknown }[];
  inputs: Record<string, any>;
}

export function getSignal(s: Store, id: number): SignalDetail | null {
  const r = one(s, 'SELECT * FROM signals WHERE id = ?', id);
  if (!r) return null;
  const base = toSignalRows(s, [r])[0];
  const conditions = all(s, 'SELECT key, family, points, detail FROM signal_conditions WHERE signal_id = ? ORDER BY points DESC, key', id).map((c) => ({
    key: c.key, family: c.family, points: c.points, detail: c.detail ? safeJson(c.detail) : null,
  }));
  return {
    signal: {
      ...base, entryLo: r.entry_lo, entryHi: r.entry_hi, rrT1: r.rr_t1, rrT2: r.rr_t2, atr: r.atr, t1Ts: r.t1_ts, t2Ts: r.t2_ts,
      stopTs: r.stop_ts, closedTs: r.closed_ts, maxFavorable: r.max_favorable, maxAdverse: r.max_adverse,
    },
    conditions,
    inputs: safeJson(r.inputs) ?? {},
  };
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

export function listAlerts(s: Store, f: { run?: string; symbol?: string; type?: string; limit?: number } = {}): AlertRow[] {
  const where = ['run_id = ?'];
  const args: any[] = [f.run ?? LIVE_RUN];
  if (f.symbol) { where.push('symbol = ?'); args.push(f.symbol); }
  if (f.type) { where.push('type = ?'); args.push(f.type); }
  return all(s, `SELECT * FROM alerts WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`, ...args, f.limit ?? 100).map((r) => ({
    id: r.id, runId: r.run_id, ts: r.ts, symbol: r.symbol, type: r.type, text: stripHtml(r.message), inputs: r.inputs,
  }));
}

export function alertTypes(s: Store, run = LIVE_RUN): string[] {
  return all(s, 'SELECT DISTINCT type FROM alerts WHERE run_id = ? ORDER BY type', run).map((r) => r.type);
}

// ---- performance -----------------------------------------------------------------------
export function performance(s: Store, run: string, symbol?: string): Report {
  return buildReport(s, run, { symbol });
}

export function compare(s: Store, a: string, b: string): Comparison {
  return compareRuns(s, a, b);
}

// ---- candles (from the candles table, else rebuilt from trades) ------------------------------
export function candlesFor(s: Store, symbol: string, fromTs: number, toTs: number, tf: Timeframe = '1m'): Candle[] {
  const stored = all(s, 'SELECT * FROM candles WHERE symbol = ? AND tf = ? AND ts >= ? AND ts <= ? ORDER BY ts', symbol, tf, fromTs, toTs);
  const expected = Math.max(1, (toTs - fromTs) / TF_MS[tf]);
  if (stored.length >= expected * 0.5) {
    return stored.map((r) => ({
      symbol, tf, ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, buyVolume: r.buy_volume,
      sellVolume: r.sell_volume, delta: r.delta, cvd: r.cvd, trades: r.trades,
    }));
  }
  // replay runs and gaps have no stored candles: rebuild from raw trades (bounded window)
  const b = new CandleBuilder(symbol, tf, 100_000);
  const rows = s.db.prepare('SELECT ts, price, size, side FROM trades WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts, agg_id').iterate(symbol, fromTs, toTs);
  for (const r of rows as Iterable<Row>) b.add({ symbol, aggId: 0, ts: r.ts, price: r.price, size: r.size, side: r.side > 0 ? 'buy' : 'sell' });
  return b.current ? [...b.history, b.current] : [...b.history];
}

export interface SignalChart {
  candles: Candle[];
  fromTs: number;
  toTs: number;
}

export function signalChart(s: Store, d: SignalDetail): SignalChart {
  const sig = d.signal;
  const fromTs = sig.ts - 90 * 60_000;
  const toTs = Math.min(sig.ts + 6 * 3_600_000, (sig.closedTs ?? sig.ts + 60 * 60_000) + 30 * 60_000);
  const candles = candlesFor(s, sig.symbol, fromTs, toTs);
  // don't leave the right half empty when the data (or a still-open signal) ends before the window does
  const last = candles.at(-1);
  return { candles, fromTs, toTs: last ? Math.min(toTs, last.ts + 4 * 60_000) : toTs };
}

// ---- heat map -----------------------------------------------------------------------------
export interface HeatmapData {
  symbol: string;
  grid: { cols: number; rows: number; fromTs: number; toTs: number; pMin: number; pMax: number; bid: string; ask: string; scale: number };
  walls: { side: string; price: number; firstSeen: number; lastSeen: number; status: string; peak: number; executed: number }[];
  line: [number, number][];
  snapshots: number;
}

export function heatmap(s: Store, cfg: Config, symbol: string, hours: number, now = Date.now(), cols = 480, maxRows = 200): HeatmapData {
  const toTs = now, fromTs = now - hours * 3_600_000;
  const snaps: BookSnap[] = all(s, 'SELECT ts, bids, asks FROM orderbook_snapshots WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts', symbol, fromTs, toTs)
    .map((r) => ({ ts: r.ts, bids: JSON.parse(r.bids), asks: JSON.parse(r.asks) }));
  const candles = candlesFor(s, symbol, fromTs, toTs);
  const line: [number, number][] = candles.map((c) => [c.ts + 30_000, c.close]);
  // price window: around where price actually traded (so the picture isn't mostly empty book far from price)
  const prices = candles.length ? candles.flatMap((c) => [c.high, c.low]) : snaps.map((x) => (x.bids[0]?.[0] + x.asks[0]?.[0]) / 2).filter(Number.isFinite);
  const bin = cfg.assets[symbol]?.binSize ?? 1;
  let pMin = 0, pMax = bin, rows = 1;
  if (prices.length) {
    const lo = Math.min(...prices), hi = Math.max(...prices), mid = (lo + hi) / 2;
    const pad = Math.max((hi - lo) * 0.25, mid * 0.002);
    // One row = a whole number of price bins, edges halfway between bin prices, so no row is ever empty just
    // because of rounding (the book's levels sit exactly on bin prices).
    const rowH = bin * Math.max(1, Math.ceil((hi - lo + 2 * pad) / bin / maxRows));
    pMax = (Math.ceil((hi + pad) / rowH - 0.5) + 0.5) * rowH;
    pMin = (Math.floor((lo - pad) / rowH - 0.5) + 0.5) * rowH;
    rows = Math.max(1, Math.round((pMax - pMin) / rowH));
  }
  const g: HeatGrid = buildHeatGrid(snaps, { fromTs, toTs, cols, rows, pMin, pMax });
  const walls = all(s, 'SELECT side, price, first_seen, last_seen, status, peak_size, executed FROM book_walls WHERE symbol = ? AND last_seen >= ? AND first_seen <= ? ORDER BY first_seen', symbol, fromTs, toTs)
    .filter((w) => w.price >= pMin && w.price <= pMax)
    .map((w) => ({ side: w.side, price: w.price, firstSeen: w.first_seen, lastSeen: w.status === 'active' ? toTs : w.last_seen, status: w.status, peak: w.peak_size, executed: w.executed }));
  return { symbol, grid: { cols: g.cols, rows: g.rows, fromTs, toTs, pMin, pMax, bid: toBase64(g.bid), ask: toBase64(g.ask), scale: g.scale }, walls, line, snapshots: snaps.length };
}

// ---- footprint ------------------------------------------------------------------------------
export interface FootprintView {
  candle: FootprintCandle;
  marks: ImbalanceMark[];
  stacked: FootprintEvent[];
  absorption: FootprintEvent[];
  delta: number;
}

export function footprints(s: Store, cfg: Config, symbol: string, tf: Timeframe, n: number): FootprintView[] {
  const tss = all(s, 'SELECT DISTINCT ts FROM footprint_levels WHERE symbol = ? AND tf = ? ORDER BY ts DESC LIMIT ?', symbol, tf, n + 20).map((r) => r.ts as number).reverse();
  if (!tss.length) return [];
  const rows = all(s, 'SELECT ts, price, bid_volume, ask_volume, trades FROM footprint_levels WHERE symbol = ? AND tf = ? AND ts >= ? ORDER BY ts, price', symbol, tf, tss[0]);
  const by = new Map<number, FootprintLevel[]>();
  for (const r of rows) by.set(r.ts, [...(by.get(r.ts) ?? []), { price: r.price, bid: r.bid_volume, ask: r.ask_volume, trades: r.trades }]);
  const ohlc = new Map(candlesFor(s, symbol, tss[0], tss[tss.length - 1] + TF_MS[tf], tf).map((c) => [c.ts, c]));
  const bin = cfg.assets[symbol]?.footprintBin ?? 1;
  const views: FootprintView[] = [];
  const vols: number[] = [];
  for (const ts of tss) {
    const levels = by.get(ts) ?? [];
    const traded = levels.filter((l) => l.bid + l.ask > 0);
    const c = ohlc.get(ts);
    const fc: FootprintCandle = {
      symbol, tf, ts, binSize: bin, levels,
      open: c?.open ?? traded[0]?.price ?? 0, close: c?.close ?? traded.at(-1)?.price ?? 0,
      high: c?.high ?? Math.max(...traded.map((l) => l.price)), low: c?.low ?? Math.min(...traded.map((l) => l.price)),
      totalBid: levels.reduce((a, l) => a + l.bid, 0), totalAsk: levels.reduce((a, l) => a + l.ask, 0),
    };
    const avg = vols.length >= Math.min(5, cfg.footprint.absorption.volLookback) ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
    views.push({
      candle: fc, marks: imbalanceMarks(fc, cfg.footprint), stacked: detectStackedImbalance(fc, cfg.footprint),
      absorption: detectAbsorption(fc, avg, cfg.footprint), delta: fc.totalAsk - fc.totalBid,
    });
    vols.push(fc.totalAsk + fc.totalBid);
    if (vols.length > cfg.footprint.absorption.volLookback) vols.shift();
  }
  return views.slice(-n).reverse(); // newest first
}

// ---- GEX --------------------------------------------------------------------------------------
export interface GexData {
  latest: { ts: number; spot: number; flipLevel: number | null; totalGex: number; instruments: number; strikes: { strike: number; callGex: number; putGex: number; gex: number; oi: number }[] } | null;
  history: { ts: number; spot: number; flipLevel: number | null; totalGex: number }[];
}

export function gex(s: Store, currency: string, hours: number, now = Date.now()): GexData {
  const l = one(s, 'SELECT * FROM gex_snapshots WHERE underlying = ? ORDER BY ts DESC LIMIT 1', currency);
  const history = all(s, 'SELECT ts, spot, flip_level, total_gex FROM gex_snapshots WHERE underlying = ? AND ts >= ? ORDER BY ts', currency, now - hours * 3_600_000)
    .map((r) => ({ ts: r.ts, spot: r.spot, flipLevel: r.flip_level, totalGex: r.total_gex }));
  return {
    latest: l ? { ts: l.ts, spot: l.spot, flipLevel: l.flip_level, totalGex: l.total_gex, instruments: l.instruments ?? 0, strikes: safeJson(l.strikes) ?? [] } : null,
    history,
  };
}

// ---- volume profile ---------------------------------------------------------------------------
export interface ProfileData {
  snapshot: ProfileSnapshot | null;
  bins: { price: number; volume: number }[];
  trades: number;
  lastPrice: number | null;
  hours: number;
}

export function profile(s: Store, cfg: Config, symbol: string, hours: number, now = Date.now()): ProfileData {
  const a = cfg.assets[symbol];
  const vp = new VolumeProfile({
    binSize: a.binSize, windowMs: hours * 3_600_000, valueAreaPct: cfg.volumeProfile.valueAreaPct, hvnFactor: cfg.volumeProfile.hvnFactor,
    hvnMinSepBins: cfg.volumeProfile.hvnMinSepBins, hvnSmoothBins: cfg.volumeProfile.hvnSmoothBins,
  });
  let n = 0, last: number | null = null, lastTs = 0;
  for (const r of s.db.prepare('SELECT ts, price, size FROM trades WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts, agg_id').iterate(symbol, now - hours * 3_600_000, now) as Iterable<Row>) {
    vp.add(r.ts, r.price, r.size);
    n++; last = r.price; lastTs = r.ts;
  }
  return { snapshot: n ? vp.snapshot(lastTs) : null, bins: n ? vp.histogram(lastTs) : [], trades: n, lastPrice: last, hours };
}

// ---- combined chart ---------------------------------------------------------------------------
export interface ChartData {
  symbol: string;
  tf: Timeframe;
  fromTs: number;
  toTs: number;
  candles: Candle[];
  profile: { poc: number; vah: number; val: number; hvns: number[] } | null;
  walls: { side: string; price: number; firstSeen: number; lastSeen: number; status: string; peak: number }[];
  gexFlip: { ts: number; flip: number }[];
  bigTrades: { ts: number; price: number; notional: number; side: number }[];
  footprint: { ts: number; kind: string; direction: string; lo: number; hi: number }[];
  signals: { id: number; ts: number; direction: 'LONG' | 'SHORT'; entry: number; score: number }[];
}

/** Everything the /chart page overlays on the candles. Anchored on the latest stored candle so old or demo data still shows. */
export function chartData(s: Store, cfg: Config, symbol: string, tf: Timeframe, hours: number, run = LIVE_RUN, now = Date.now()): ChartData {
  const latest = one(s, 'SELECT MAX(ts) t FROM candles WHERE symbol = ? AND tf = ?', symbol, tf)?.t ?? one(s, 'SELECT MAX(ts) t FROM trades WHERE symbol = ?', symbol)?.t ?? null;
  const toTs = latest != null ? Math.min(now, latest + TF_MS[tf]) : now;
  const fromTs = toTs - hours * 3_600_000;
  const candles = candlesFor(s, symbol, fromTs, toTs, tf);
  const p = candles.length ? profile(s, cfg, symbol, 24, toTs) : null;
  const walls = all(s, 'SELECT side, price, first_seen, last_seen, status, peak_size FROM book_walls WHERE symbol = ? AND last_seen >= ? AND first_seen <= ? ORDER BY first_seen', symbol, fromTs, toTs)
    .map((w) => ({ side: w.side, price: w.price, firstSeen: w.first_seen, lastSeen: w.status === 'active' ? toTs : w.last_seen, status: w.status, peak: w.peak_size }));
  const underlying = (cfg.gex.underlyings as Record<string, string>)[symbol];
  const gexFlip = underlying
    ? all(s, 'SELECT ts, flip_level FROM gex_snapshots WHERE underlying = ? AND ts >= ? AND ts <= ? AND flip_level IS NOT NULL ORDER BY ts', underlying, fromTs, toTs).map((r) => ({ ts: r.ts, flip: r.flip_level }))
    : [];
  const bigTrades = all(s, 'SELECT ts, price, notional, side FROM big_trades WHERE run_id = ? AND symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT 2000', run, symbol, fromTs, toTs)
    .map((r) => ({ ts: r.ts, price: r.price, notional: r.notional, side: r.side }));
  const footprint = all(s, 'SELECT ts, kind, direction, lo, hi FROM footprint_events WHERE run_id = ? AND symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts', run, symbol, fromTs, toTs);
  const signals = all(s, 'SELECT id, ts, direction, entry, score FROM signals WHERE run_id = ? AND symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts', run, symbol, fromTs, toTs)
    .map((r) => ({ id: r.id, ts: r.ts, direction: r.direction, entry: r.entry, score: r.score }));
  return {
    symbol, tf, fromTs, toTs, candles,
    profile: p?.snapshot ? { poc: p.snapshot.poc, vah: p.snapshot.vah, val: p.snapshot.val, hvns: p.snapshot.hvns.map((h) => h.price) } : null,
    walls, gexFlip, bigTrades, footprint: footprint as ChartData['footprint'], signals,
  };
}
