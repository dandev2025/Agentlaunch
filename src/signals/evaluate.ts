import type { Config } from '../config/types.js';
import type { BigTrade, Direction, Level, ProfileSnapshot } from '../core/types.js';
import { profileLevels } from '../alerts/rules.js';

export interface RecentEvent {
  direction: Direction;
  ts: number;
  detail?: unknown;
}

export interface FootprintMemo extends RecentEvent {
  kind: 'stacked_imbalance' | 'absorption';
  lo: number;
  hi: number;
}

export interface EvalContext {
  symbol: string;
  ts: number;
  price: number;
  atr: number | null;
  near: number;
  profile: ProfileSnapshot | null;
  flips: RecentEvent[]; // delta flips (direction = new sign)
  divergences: RecentEvent[]; // bullish => LONG, bearish => SHORT
  bigTrades: BigTrade[]; // recent window
  fpEvents?: FootprintMemo[]; // recent footprint detections
  htfZ: number | null;
}

export interface FiredCondition {
  key: string;
  family: 'profile' | 'delta' | 'bigtrades' | 'footprint';
  points: number;
  detail: unknown;
}

export interface Candidate {
  symbol: string;
  ts: number;
  direction: Direction;
  score: number;
  conditions: FiredCondition[];
  entry: number;
  entryLo: number;
  entryHi: number;
  stop: number;
  t1: number;
  t2: number;
  rr: number;
  rrT1: number;
  rrT2: number;
  atr: number;
  level: Level;
  t2Synthetic: boolean;
  inputs: Record<string, unknown>;
}

export type Evaluation = { ok: true; candidate: Candidate } | { ok: false; reason: string; conditions: FiredCondition[]; score: number };

const SUPPORT_KINDS = ['VAL', 'POC', 'HVN'];
const RESIST_KINDS = ['VAH', 'POC', 'HVN'];

/** Pure: no clocks, no I/O. Evaluates one direction. */
export function evaluateDirection(
  cfg: Config['signals'],
  ctx: EvalContext,
  dir: Direction,
  fpCfg: Pick<Config['footprint'], 'requireAtLevel'> = { requireAtLevel: true },
): Evaluation {
  const long = dir === 'LONG';
  const fail = (reason: string, conditions: FiredCondition[] = [], score = 0): Evaluation => ({ ok: false, reason, conditions, score });
  if (!ctx.profile) return fail('no_profile');
  if (ctx.atr == null) return fail('no_atr');

  const w = (k: string) => cfg.weights[k] ?? 0;
  const conditions: FiredCondition[] = [];
  const ttl = cfg.conditionTtlMs;
  const fresh = (e: RecentEvent) => e.direction === dir && ctx.ts - e.ts <= ttl;

  // 1) Price at / near a level acting as support (long) or resistance (short).
  const kinds = long ? SUPPORT_KINDS : RESIST_KINDS;
  let level: Level | null = null;
  let bestDist = Infinity;
  for (const l of profileLevels(ctx.profile)) {
    if (!kinds.includes(l.kind)) continue;
    const d = Math.abs(ctx.price - l.price);
    // Support must not be well above price (it would be resistance); resistance must not be well below.
    const sideOk = long ? l.price <= ctx.price + ctx.near : l.price >= ctx.price - ctx.near;
    if (d <= ctx.near && sideOk && d < bestDist) { level = l; bestDist = d; }
  }
  if (level) {
    const key = `level:${level.kind}`;
    conditions.push({ key, family: 'profile', points: w(key), detail: { price: level.price, distance: bestDist, near: ctx.near } });
  }

  // 2) Delta: flip and/or divergence
  const flip = ctx.flips.filter(fresh).at(-1);
  if (flip) conditions.push({ key: 'delta_flip', family: 'delta', points: w('delta_flip'), detail: flip });
  const div = ctx.divergences.filter(fresh).at(-1);
  if (div) conditions.push({ key: 'divergence', family: 'delta', points: w('divergence'), detail: div });

  // 3) Big prints in our direction at the level
  if (level) {
    const at = ctx.bigTrades.filter((b) => Math.abs(b.price - level!.price) <= ctx.near);
    const mine = at.filter((b) => (b.side === 'buy') === long);
    const theirs = at.filter((b) => (b.side === 'buy') !== long);
    const sum = (a: BigTrade[]) => a.reduce((s, b) => s + b.notional, 0);
    if (mine.length >= cfg.bigPrints.minCount && sum(mine) > sum(theirs)) {
      conditions.push({
        key: 'big_prints', family: 'bigtrades', points: w('big_prints'),
        detail: { count: mine.length, notional: sum(mine), opposingNotional: sum(theirs) },
      });
    }
  }

  // 4) Footprint: stacked imbalance / absorption supporting this direction, at the level when required
  for (const [kind, key] of [['stacked_imbalance', 'fp_stacked_imbalance'], ['absorption', 'fp_absorption']] as const) {
    const ev = (ctx.fpEvents ?? []).filter((e) => e.kind === kind && fresh(e)).at(-1);
    if (!ev) continue;
    if (fpCfg.requireAtLevel && !(level && level.price >= ev.lo - ctx.near && level.price <= ev.hi + ctx.near)) continue;
    conditions.push({ key, family: 'footprint', points: w(key), detail: ev.detail });
  }

  const score = conditions.reduce((s, c) => s + c.points, 0);

  // Higher-timeframe filter: never fight strong 15m cumulative delta.
  if (ctx.htfZ != null) {
    if (long && ctx.htfZ <= -cfg.htf.strongZ) return fail('htf_filter', conditions, score);
    if (!long && ctx.htfZ >= cfg.htf.strongZ) return fail('htf_filter', conditions, score);
  }

  if (conditions.length < cfg.minConditions) return fail('min_conditions', conditions, score);
  if (new Set(conditions.map((c) => c.family)).size < cfg.minFamilies) return fail('min_families', conditions, score);
  if (score < cfg.threshold) return fail('below_threshold', conditions, score);
  if (!level) return fail('no_level', conditions, score); // unreachable in practice: 3 conditions need ≥1 level-or-delta mix

  // ---- trade plan -----------------------------------------------------------
  const r = cfg.risk;
  const atr = ctx.atr;
  const s = long ? 1 : -1;
  const stop = level.price - s * r.stopAtrMult * atr;
  const entry = ctx.price;
  if ((entry - stop) * s <= 0) return fail('price_through_stop', conditions, score);
  const risk = (entry - stop) * s;
  const zoneLo = Math.min(level.price - r.entryZoneAtr * atr, entry);
  const zoneHi = Math.max(level.price + r.entryZoneAtr * atr, entry);

  const targets = profileLevels(ctx.profile)
    .filter((l) => (l.price - entry) * s >= r.minTargetAtr * atr)
    .sort((a, b) => (a.price - b.price) * s);
  if (!targets.length) return fail('no_targets', conditions, score);
  const t1 = targets[0].price;
  const t2Synthetic = targets.length < 2;
  const t2 = t2Synthetic ? t1 + s * r.fallbackT2Atr * atr : targets[1].price;
  const rrT1 = ((t1 - entry) * s) / risk;
  const rrT2 = ((t2 - entry) * s) / risk;
  const rr = r.rrBasis === 'T2' ? rrT2 : rrT1;
  if (rr < r.minRR) return fail('min_rr', conditions, score);

  return {
    ok: true,
    candidate: {
      symbol: ctx.symbol, ts: ctx.ts, direction: dir, score, conditions, entry, entryLo: zoneLo, entryHi: zoneHi,
      stop, t1, t2, rr, rrT1, rrT2, atr, level, t2Synthetic,
      inputs: {
        price: ctx.price, atr, near: ctx.near, htfZ: ctx.htfZ, profile: ctx.profile, level,
        targetKinds: [targets[0].kind, t2Synthetic ? 'ATR' : targets[1].kind],
        thresholds: { threshold: cfg.threshold, minConditions: cfg.minConditions, minFamilies: cfg.minFamilies, minRR: r.minRR },
        weights: cfg.weights,
      },
    },
  };
}
