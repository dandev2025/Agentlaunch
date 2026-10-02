import type { Store } from '../db/store.js';

export interface Stats {
  n: number;
  wins: number;
  winRate: number;
  avgR: number;
  totalR: number;
  profitFactor: number | null;
  avgMfeR: number;
  avgMaeR: number;
  outcomes: Record<string, number>;
}

export interface ConditionStats extends Stats {
  key: string;
  /** Average R of closed signals that did NOT include this condition. */
  avgRWithout: number | null;
  nWithout: number;
  lift: number | null;
}

export interface Report {
  runId: string;
  total: number;
  open: number;
  overall: Stats;
  byDirection: Record<string, Stats>;
  bySymbol: Record<string, Stats>;
  byCondition: ConditionStats[];
  /** Same with/without view, per indicator family. */
  byFamily: ConditionStats[];
  /** Does a higher score actually do better? Buckets of 10 points, ascending. */
  byScoreBucket: ({ bucket: string } & Stats)[];
  byFamilyCount: Record<string, Stats>;
}

export interface Row {
  id: number;
  ts: number;
  symbol: string;
  direction: string;
  score: number;
  outcome: string;
  r: number;
  mfeR: number;
  maeR: number;
  keys: Set<string>;
  families: Set<string>;
}

export function computeStats(rows: Pick<Row, 'outcome' | 'r' | 'mfeR' | 'maeR'>[]): Stats {
  const n = rows.length;
  const wins = rows.filter((r) => r.r > 0).length;
  const gain = rows.filter((r) => r.r > 0).reduce((a, r) => a + r.r, 0);
  const loss = -rows.filter((r) => r.r < 0).reduce((a, r) => a + r.r, 0);
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
  const outcomes: Record<string, number> = {};
  for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  return {
    n, wins,
    winRate: n ? wins / n : 0,
    avgR: n ? sum((r) => r.r) / n : 0,
    totalR: sum((r) => r.r),
    profitFactor: loss > 0 ? gain / loss : gain > 0 ? Infinity : null,
    avgMfeR: n ? sum((r) => r.mfeR) / n : 0,
    avgMaeR: n ? sum((r) => r.maeR) / n : 0,
    outcomes,
  };
}

/** Closed signals of a run with their conditions, families and outcomes. */
export function loadClosedRows(store: Store, runId: string, filter: { symbol?: string } = {}): { rows: Row[]; total: number } {
  const where = `run_id = ? ${filter.symbol ? 'AND symbol = ?' : ''}`;
  const args = filter.symbol ? [runId, filter.symbol] : [runId];
  const sigs = store.db
    .prepare(
      `SELECT id, ts, symbol, direction, score, outcome, realized_r, max_favorable_r, max_adverse_r, status FROM signals WHERE ${where}`,
    )
    .all(...args) as Record<string, any>[];
  const conds = store.db
    .prepare(`SELECT signal_id, key, family FROM signal_conditions WHERE signal_id IN (SELECT id FROM signals WHERE ${where})`)
    .all(...args) as { signal_id: number; key: string; family: string }[];
  const keysById = new Map<number, { keys: Set<string>; families: Set<string> }>();
  for (const c of conds) {
    if (!keysById.has(c.signal_id)) keysById.set(c.signal_id, { keys: new Set(), families: new Set() });
    keysById.get(c.signal_id)!.keys.add(c.key);
    keysById.get(c.signal_id)!.families.add(c.family);
  }
  const rows: Row[] = sigs
    .filter((s) => s.status === 'CLOSED' && s.realized_r != null)
    .map((s) => ({
      id: s.id, ts: s.ts, symbol: s.symbol, direction: s.direction, score: s.score, outcome: s.outcome, r: s.realized_r,
      mfeR: s.max_favorable_r, maeR: s.max_adverse_r,
      keys: keysById.get(s.id)?.keys ?? new Set(), families: keysById.get(s.id)?.families ?? new Set(),
    }));
  return { rows, total: sigs.length };
}

/** Stats for signals containing each tag, versus those without it ("lift" = avgR with minus avgR without). */
function withWithout(closed: Row[], tagsOf: (r: Row) => Set<string>): ConditionStats[] {
  const all = [...new Set(closed.flatMap((r) => [...tagsOf(r)]))].sort();
  return all.map((key) => {
    const withK = closed.filter((r) => tagsOf(r).has(key));
    const without = closed.filter((r) => !tagsOf(r).has(key));
    const s = computeStats(withK);
    const avgRWithout = without.length ? computeStats(without).avgR : null;
    return { key, ...s, avgRWithout, nWithout: without.length, lift: avgRWithout == null ? null : s.avgR - avgRWithout };
  });
}

export function buildReport(store: Store, runId: string, filter: { symbol?: string } = {}): Report {
  const { rows: closed, total } = loadClosedRows(store, runId, filter);

  const group = (f: (r: Row) => string) => {
    const m = new Map<string, Row[]>();
    for (const r of closed) m.set(f(r), [...(m.get(f(r)) ?? []), r]);
    return Object.fromEntries([...m].sort().map(([k, v]) => [k, computeStats(v)]));
  };

  const buckets = new Map<number, Row[]>();
  for (const r of closed) {
    const b = Math.floor(r.score / 10) * 10;
    buckets.set(b, [...(buckets.get(b) ?? []), r]);
  }

  return {
    runId,
    total,
    open: total - closed.length,
    overall: computeStats(closed),
    byDirection: group((r) => r.direction),
    bySymbol: group((r) => r.symbol),
    byCondition: withWithout(closed, (r) => r.keys),
    byFamily: withWithout(closed, (r) => r.families),
    byScoreBucket: [...buckets].sort((a, b) => a[0] - b[0]).map(([b, rows]) => ({ bucket: `${b}-${b + 9}`, ...computeStats(rows) })),
    byFamilyCount: group((r) => String(r.families.size)),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (x: number | null, d = 2) => (x == null ? '-' : Number.isFinite(x) ? x.toFixed(d) : '∞');

export function formatReport(r: Report): string {
  const line = (label: string, s: Stats) =>
    `${label.padEnd(22)} ${String(s.n).padStart(5)} ${pct(s.winRate).padStart(7)} ${num(s.avgR).padStart(7)} ${num(s.totalR).padStart(8)} ${num(s.profitFactor).padStart(6)} ${num(s.avgMfeR).padStart(7)} ${num(s.avgMaeR).padStart(7)}`;
  const head = `${''.padEnd(22)} ${'n'.padStart(5)} ${'win%'.padStart(7)} ${'avgR'.padStart(7)} ${'totR'.padStart(8)} ${'PF'.padStart(6)} ${'MFE_R'.padStart(7)} ${'MAE_R'.padStart(7)}`;
  const out: string[] = [
    `Backtest report — run "${r.runId}": ${r.total} signals (${r.overall.n} closed, ${r.open} still open/excluded)`,
    '',
    head,
    line('ALL', r.overall),
    ...Object.entries(r.byDirection).map(([k, s]) => line(k, s)),
    ...Object.entries(r.bySymbol).map(([k, s]) => line(k, s)),
    '',
    'Per condition (signals that contained it) — "lift" = avgR with minus avgR without:',
    `${'condition'.padEnd(22)} ${'n'.padStart(5)} ${'win%'.padStart(7)} ${'avgR'.padStart(7)} ${'totR'.padStart(8)} ${'avgR w/o'.padStart(9)} ${'lift'.padStart(7)}`,
    ...r.byCondition.map(
      (c) =>
        `${c.key.padEnd(22)} ${String(c.n).padStart(5)} ${pct(c.winRate).padStart(7)} ${num(c.avgR).padStart(7)} ${num(c.totalR).padStart(8)} ${num(c.avgRWithout).padStart(9)} ${num(c.lift).padStart(7)}`,
    ),
    '',
    'Per indicator family (signals that contained it):',
    `${'family'.padEnd(22)} ${'n'.padStart(5)} ${'win%'.padStart(7)} ${'avgR'.padStart(7)} ${'totR'.padStart(8)} ${'avgR w/o'.padStart(9)} ${'lift'.padStart(7)}`,
    ...r.byFamily.map(
      (c) =>
        `${c.key.padEnd(22)} ${String(c.n).padStart(5)} ${pct(c.winRate).padStart(7)} ${num(c.avgR).padStart(7)} ${num(c.totalR).padStart(8)} ${num(c.avgRWithout).padStart(9)} ${num(c.lift).padStart(7)}`,
    ),
    '',
    'By score (does a higher score do better?):',
    head,
    ...r.byScoreBucket.map((b) => line(b.bucket, b)),
    ...Object.entries(r.byFamilyCount).map(([k, s]) => line(`${k} families`, s)),
    '',
    'Outcomes: ' + (Object.entries(r.overall.outcomes).map(([k, v]) => `${k}=${v}`).join('  ') || '-'),
    'R model: -1R at stop; after T1, half is banked and the rest runs to T2 or the original stop (see signals.tracking.t1Fraction).',
  ];
  if (r.overall.n < 30) out.push('⚠ Fewer than 30 closed signals — treat every number above as noise, not evidence.');
  return out.join('\n');
}
