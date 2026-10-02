import type { Config } from '../config/types.js';
import type { Store } from '../db/store.js';
import { LIVE_RUN } from '../db/store.js';

export interface SymbolTune {
  symbol: string;
  trades: number;
  tradesPerHour: number;
  size: { p50: number; p90: number; p99: number; p999: number; max: number };
  big: { minQty: number | null; minNotionalUsd: number | null; perHour: number; suggestedMinQty: number; suggestedPerHour: number };
  walls: {
    total: number;
    perHour: number;
    /** share of walls that lived under 30s (flash orders / spoofing) */
    flashShare: number;
    steadyPerHour: number; // lived >= 60s
    byStatus: Record<string, number>;
    currentMinQty: number;
    suggestedMinQty: number | null;
  };
  alerts: { total: number; perHour: number; byType: Record<string, number> };
  signals: number;
}

export interface TuneReport {
  /** false when the database holds no trades yet */
  hasData: boolean;
  hours: number; // span of data analysed
  fromTs: number;
  toTs: number;
  targets: { bigPerHour: number; steadyWallsPerHour: number; alertsPerHour: number };
  symbols: SymbolTune[];
}

/** Round to 2 significant digits so a suggested threshold is a tidy number. */
export function round2(x: number): number {
  if (!(x > 0)) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  return Math.round(x / mag) * mag;
}

const q = (sorted: number[], p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : 0);

/** The size such that about `perHour * hours` observations are at least that big. */
export function thresholdForRate(sortedAsc: number[], hours: number, perHour: number): number {
  const k = Math.max(1, Math.round(perHour * hours));
  return sortedAsc.length ? sortedAsc[Math.max(0, sortedAsc.length - k)] : 0;
}

/**
 * Measures the real data in the database against the configured thresholds, and suggests values that would produce roughly
 * `targets` events per hour. The suggestions are a starting point for tuning — they only tell you what a threshold *does* on the
 * data you collected, not whether those events are worth acting on.
 */
export function analyze(
  store: Store,
  cfg: Config,
  o: { hours?: number; now?: number; targets?: Partial<TuneReport['targets']> } = {},
): TuneReport {
  const targets = { bigPerHour: 12, steadyWallsPerHour: 6, alertsPerHour: 6, ...o.targets };
  const toTs = o.now ?? Date.now();
  const fromAsked = toTs - (o.hours ?? 24) * 3_600_000;
  const syms = Object.entries(cfg.assets).filter(([, a]) => a.enabled).map(([s]) => s);
  const range = store.tradeRange(syms);
  // With no stored trades there is nothing to measure: report a one-minute span rather than the requested window.
  const fromTs = range ? Math.max(fromAsked, range.min) : toTs - 60_000;
  const hours = Math.max(1 / 60, (Math.min(toTs, range?.max ?? toTs) - fromTs) / 3_600_000);

  const one = (sql: string, ...a: any[]) => store.db.prepare(sql).get(...a) as Record<string, any>;
  const all = (sql: string, ...a: any[]) => store.db.prepare(sql).all(...a) as Record<string, any>[];

  const symbols = syms.map((symbol): SymbolTune => {
    const a = cfg.assets[symbol];
    const sizes: number[] = [];
    for (const r of store.db.prepare('SELECT size FROM trades WHERE symbol = ? AND ts >= ? AND ts <= ?').iterate(symbol, fromTs, toTs) as Iterable<{ size: number }>) sizes.push(r.size);
    sizes.sort((x, y) => x - y);
    const bigNow = a.bigTrade.minQty == null ? 0 : sizes.length - lowerBound(sizes, a.bigTrade.minQty);
    const sugg = round2(thresholdForRate(sizes, hours, targets.bigPerHour));
    const suggCount = sizes.length - lowerBound(sizes, sugg);

    const walls = all('SELECT status, first_seen, last_seen, peak_size FROM book_walls WHERE symbol = ? AND last_seen >= ? AND first_seen <= ?', symbol, fromTs, toTs);
    const lived = (w: Record<string, any>) => w.last_seen - w.first_seen;
    const steady = walls.filter((w) => lived(w) >= 60_000).map((w) => w.peak_size as number).sort((x, y) => x - y);
    const byStatus: Record<string, number> = {};
    for (const w of walls) byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
    const steadyTarget = Math.round(targets.steadyWallsPerHour * hours);

    const alertRows = all('SELECT type, COUNT(*) c FROM alerts WHERE run_id = ? AND symbol = ? AND ts >= ? AND ts <= ? GROUP BY type', LIVE_RUN, symbol, fromTs, toTs);
    const alertTotal = alertRows.reduce((n, r) => n + r.c, 0);

    return {
      symbol,
      trades: sizes.length,
      tradesPerHour: sizes.length / hours,
      size: { p50: q(sizes, 0.5), p90: q(sizes, 0.9), p99: q(sizes, 0.99), p999: q(sizes, 0.999), max: sizes.at(-1) ?? 0 },
      big: { minQty: a.bigTrade.minQty, minNotionalUsd: a.bigTrade.minNotionalUsd, perHour: bigNow / hours, suggestedMinQty: sugg, suggestedPerHour: suggCount / hours },
      walls: {
        total: walls.length,
        perHour: walls.length / hours,
        flashShare: walls.length ? walls.filter((w) => lived(w) < 30_000).length / walls.length : 0,
        steadyPerHour: steady.length / hours,
        byStatus,
        currentMinQty: a.wallMinQty,
        // stored walls are already filtered by the current threshold, so we can only suggest raising it
        suggestedMinQty: steady.length > steadyTarget && steadyTarget > 0 ? round2(steady[steady.length - steadyTarget]) : null,
      },
      alerts: { total: alertTotal, perHour: alertTotal / hours, byType: Object.fromEntries(alertRows.map((r) => [r.type, r.c])) },
      signals: one('SELECT COUNT(*) c FROM signals WHERE run_id = ? AND symbol = ? AND ts >= ? AND ts <= ?', LIVE_RUN, symbol, fromTs, toTs).c,
    };
  });
  return { hasData: !!range, hours, fromTs, toTs, targets, symbols };
}

/** Index of the first element >= x in an ascending array. */
function lowerBound(a: number[], x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const n1 = (x: number) => (x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(3));

export function formatTune(r: TuneReport): string {
  const out: string[] = [];
  if (!r.hasData) return 'No trades are stored yet — start the collector (`npm run collect`), let it run for a while, then try again.';
  out.push(`Analysed ${r.hours.toFixed(1)} hours of collected data (${new Date(r.fromTs).toISOString().slice(0, 16)}Z → ${new Date(r.toTs).toISOString().slice(0, 16)}Z).`);
  if (r.hours < 3) out.push('⚠ Under 3 hours of data — fine for spotting a wildly wrong threshold, too little to fine-tune.');
  for (const s of r.symbols) {
    out.push('', `== ${s.symbol} ==  ${Math.round(s.tradesPerHour).toLocaleString('en-US')} trades/hour`);
    out.push(`Trade size (base units): median ${n1(s.size.p50)} · 90th pct ${n1(s.size.p90)} · 99th ${n1(s.size.p99)} · 99.9th ${n1(s.size.p999)} · largest ${n1(s.size.max)}`);
    const cur = s.big.minQty == null ? `$${s.big.minNotionalUsd}` : n1(s.big.minQty);
    out.push(`Big trades: threshold ${cur} gives ${n1(s.big.perHour)}/hour.  For ~${r.targets.bigPerHour}/hour use  assets.${s.symbol}.bigTrade.minQty = ${n1(s.big.suggestedMinQty)}  (≈${n1(s.big.suggestedPerHour)}/hour)`);
    const w = s.walls;
    out.push(`Walls: ${w.total} recorded (${n1(w.perHour)}/hour; ${(w.flashShare * 100).toFixed(0)}% lived under 30s; ${n1(w.steadyPerHour)}/hour lasted a minute or more) ${JSON.stringify(w.byStatus)}`);
    out.push(w.suggestedMinQty == null
      ? `       wallMinQty ${n1(w.currentMinQty)} already gives ≤ ${r.targets.steadyWallsPerHour} lasting walls/hour (raise it only if the heat map is too busy)`
      : `       For ~${r.targets.steadyWallsPerHour} lasting walls/hour use  assets.${s.symbol}.wallMinQty = ${n1(w.suggestedMinQty)}  (now ${n1(w.currentMinQty)})`);
    const chatty = s.alerts.perHour > r.targets.alertsPerHour;
    out.push(`Alerts: ${s.alerts.total} (${n1(s.alerts.perHour)}/hour)${chatty ? `  ← chattier than ~${r.targets.alertsPerHour}/hour` : ''}  ${JSON.stringify(s.alerts.byType)}   Signals: ${s.signals}`);
  }
  out.push('', 'Suggestions only match event *rates* to the targets; they say nothing about whether those events are worth acting on. Edit config/config.json, restart the collector, and re-run this later.');
  return out.join('\n');
}
