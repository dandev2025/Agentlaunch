import type { Store } from '../db/store.js';
import { computeStats, loadClosedRows, type Row, type Stats } from './report.js';

export interface Comparison {
  a: string;
  b: string;
  overall: { a: Stats; b: Stats };
  /** Same symbol, direction and timestamp in both runs. R is each run's own. */
  common: { n: number; a: Stats; b: Stats };
  onlyA: Stats;
  onlyB: Stats;
  openA: number;
  openB: number;
}

const key = (r: Row) => `${r.symbol}|${r.direction}|${r.ts}`;

/**
 * Compares two replay runs over the same trades (e.g. confluence off vs on). Signals are matched by
 * (symbol, direction, ts); "only in A/B" are the signals one configuration took and the other skipped,
 * which is what tells you whether a scoring change filtered out losers or winners.
 */
export function compareRuns(store: Store, a: string, b: string): Comparison {
  const A = loadClosedRows(store, a), B = loadClosedRows(store, b);
  const mb = new Map(B.rows.map((r) => [key(r), r]));
  const ma = new Map(A.rows.map((r) => [key(r), r]));
  const commonA = A.rows.filter((r) => mb.has(key(r)));
  return {
    a, b,
    overall: { a: computeStats(A.rows), b: computeStats(B.rows) },
    common: { n: commonA.length, a: computeStats(commonA), b: computeStats(commonA.map((r) => mb.get(key(r))!)) },
    onlyA: computeStats(A.rows.filter((r) => !mb.has(key(r)))),
    onlyB: computeStats(B.rows.filter((r) => !ma.has(key(r)))),
    openA: A.total - A.rows.length,
    openB: B.total - B.rows.length,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (x: number | null, d = 2) => (x == null ? '-' : Number.isFinite(x) ? x.toFixed(d) : '∞');

export function formatComparison(c: Comparison): string {
  const row = (label: string, s: Stats) =>
    `${label.padEnd(28)} ${String(s.n).padStart(5)} ${pct(s.winRate).padStart(7)} ${num(s.avgR).padStart(7)} ${num(s.totalR).padStart(8)} ${num(s.profitFactor).padStart(6)}`;
  const out = [
    `Compare A="${c.a}" vs B="${c.b}" (closed signals; ${c.openA}/${c.openB} still open and excluded)`,
    '',
    `${''.padEnd(28)} ${'n'.padStart(5)} ${'win%'.padStart(7)} ${'avgR'.padStart(7)} ${'totR'.padStart(8)} ${'PF'.padStart(6)}`,
    row('A overall', c.overall.a),
    row('B overall', c.overall.b),
    '',
    row(`in both — A's outcome`, c.common.a),
    row(`in both — B's outcome`, c.common.b),
    row('only in A (B skipped them)', c.onlyA),
    row('only in B (A skipped them)', c.onlyB),
    '',
    'Reading it: if "only in A" has a negative avgR, B was right to skip those; if positive, B threw away winners.',
    'Caveat: cooldowns shift later signals too (a signal one run takes starts its cooldown and can block a setup the other run takes),',
    'so the "only in" buckets are not purely the effect of the scoring change.',
  ];
  if (Math.min(c.onlyA.n, c.onlyB.n) < 15 && c.onlyA.n + c.onlyB.n > 0) out.push('⚠ Fewer than 15 signals in a difference bucket — that is not enough to conclude anything.');
  return out.join('\n');
}
