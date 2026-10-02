import type { Config } from '../config/types.js';
import type { BigTrade, Direction, Level, GexView, ProfileSnapshot, WallView } from '../core/types.js';
import { profileLevels } from '../alerts/rules.js';
import { scoreConfluence, type ConfluenceResult } from './confluence.js';

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
  walls?: WallView[]; // resting walls standing right now (heat map)
  gex?: GexView | null; // latest options GEX snapshot (BTC/ETH only)
  htfZ: number | null;
}

export interface FiredCondition {
  key: string;
  family: 'profile' | 'delta' | 'bigtrades' | 'footprint' | 'heatmap' | 'gex';
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
  confluence: ConfluenceResult;
  inputs: Record<string, unknown>;
}

export type Evaluation = { ok: true; candidate: Candidate } | { ok: false; reason: string; conditions: FiredCondition[]; score: number };

const SUPPORT_KINDS = ['VAL', 'POC', 'HVN'];
const RESIST_KINDS = ['VAH', 'POC', 'HVN'];

type FpCfg = Pick<Config['footprint'], 'requireAtLevel'>;
type HeatCfg = Pick<Config['heatmap'], 'requireAtLevel'> & Pick<Config['heatmap']['wall'], 'minAgeMs' | 'holdFrac'>;
type GexCfg = Pick<Config['gex'], 'maxAgeMs' | 'minDistancePct'>;

/**
 * Every condition that supports `dir` right now. `relaxed` is used to gather *opposing* evidence:
 * no profile-level condition is produced, and "at the level" checks use the current price instead,
 * so e.g. bearish absorption near price counts against a long even when no resistance level is there.
 */
function collectConditions(
  cfg: Config['signals'], ctx: EvalContext, dir: Direction, fpCfg: FpCfg, heat: HeatCfg, gexCfg: GexCfg, relaxed: boolean,
): { conditions: FiredCondition[]; level: Level | null } {
  const long = dir === 'LONG';
  const profile = ctx.profile!;
  const w = (k: string) => cfg.weights[k] ?? 0;
  const conditions: FiredCondition[] = [];
  const fresh = (e: RecentEvent) => e.direction === dir && ctx.ts - e.ts <= cfg.conditionTtlMs;

  // 1) Price at / near a level acting as support (long) or resistance (short).
  let level: Level | null = null;
  if (relaxed) {
    level = { kind: 'POC', price: ctx.price }; // anchor only; never reported or turned into a condition
  } else {
    const kinds = long ? SUPPORT_KINDS : RESIST_KINDS;
    let bestDist = Infinity;
    for (const l of profileLevels(profile)) {
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

  // 5) Heat map: a persistent resting wall under (long) / over (short) price that is holding
  {
    const tol = profile.binSize / 2; // wall prices are bin labels, so allow half a bin of slop
    const holding = (ctx.walls ?? [])
      .filter((wl) => {
        if (wl.side !== (long ? 'bid' : 'ask')) return false;
        const dist = long ? ctx.price - wl.price : wl.price - ctx.price; // >0 = wall is on the protective side
        if (dist < -tol || dist > ctx.near) return false;
        if (ctx.ts - wl.firstSeen < heat.minAgeMs) return false; // flash orders don't count
        if (wl.size < heat.holdFrac * wl.peak) return false; // already being eaten / pulled
        return !heat.requireAtLevel || (level != null && Math.abs(wl.price - level.price) <= ctx.near);
      })
      .sort((a, b) => b.size - a.size)[0];
    if (holding) {
      conditions.push({
        key: 'wall_holding', family: 'heatmap', points: w('wall_holding'),
        detail: { side: holding.side, price: holding.price, size: holding.size, peak: holding.peak, ageMs: ctx.ts - holding.firstSeen, executed: holding.executed },
      });
    }
  }

  // 6) GEX regime (BTC/ETH only): LONG above the flip level (positive-gamma side), SHORT below it
  if (ctx.gex?.flipLevel != null && ctx.ts - ctx.gex.ts <= gexCfg.maxAgeMs) {
    const flipLevel = ctx.gex.flipLevel;
    const dist = (ctx.price - flipLevel) / flipLevel; // > 0: above the flip
    if ((long ? dist : -dist) >= gexCfg.minDistancePct) {
      conditions.push({
        key: 'gex_flip', family: 'gex', points: w('gex_flip'),
        detail: {
          flipLevel, distancePct: dist, totalGex: ctx.gex.totalGex, snapshotAgeMs: ctx.ts - ctx.gex.ts,
          regime: dist > 0 ? 'above_flip' : 'below_flip',
        },
      });
    }
  }

  return { conditions, level: relaxed ? null : level };
}

/** Pure: no clocks, no I/O. Evaluates one direction. */
export function evaluateDirection(
  cfg: Config['signals'],
  ctx: EvalContext,
  dir: Direction,
  fpCfg: FpCfg = { requireAtLevel: true },
  heat: HeatCfg = { requireAtLevel: true, minAgeMs: 30_000, holdFrac: 0.7 },
  gexCfg: GexCfg = { maxAgeMs: 1_800_000, minDistancePct: 0.001 },
): Evaluation {
  const long = dir === 'LONG';
  const fail = (reason: string, conditions: FiredCondition[] = [], score = 0): Evaluation => ({ ok: false, reason, conditions, score });
  if (!ctx.profile) return fail('no_profile');
  if (ctx.atr == null) return fail('no_atr');

  const { conditions, level } = collectConditions(cfg, ctx, dir, fpCfg, heat, gexCfg, false);
  const flat = conditions.reduce((s, c) => s + c.points, 0);

  // Higher-timeframe filter: never fight strong 15m cumulative delta.
  if (ctx.htfZ != null) {
    if (long && ctx.htfZ <= -cfg.htf.strongZ) return fail('htf_filter', conditions, flat);
    if (!long && ctx.htfZ >= cfg.htf.strongZ) return fail('htf_filter', conditions, flat);
  }

  if (conditions.length < cfg.minConditions) return fail('min_conditions', conditions, flat);
  if (new Set(conditions.map((c) => c.family)).size < cfg.minFamilies) return fail('min_families', conditions, flat);

  // Confluence: collapse correlated conditions, reward independent agreement, penalise opposing evidence.
  const cf = cfg.confluence;
  const opposing = cf.enabled && cf.conflict.weight > 0
    ? collectConditions(cfg, ctx, long ? 'SHORT' : 'LONG', fpCfg, heat, gexCfg, true).conditions
    : [];
  const confluence = scoreConfluence(cf, conditions, opposing);
  const score = confluence.score;
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

  // Levels of different kinds can coincide (e.g. VAH == an HVN): they are one target, not two.
  const targets = profileLevels(ctx.profile)
    .filter((l) => (l.price - entry) * s >= r.minTargetAtr * atr)
    .sort((a, b) => (a.price - b.price) * s)
    .filter((l, i, arr) => i === 0 || Math.abs(l.price - arr[i - 1].price) >= ctx.profile!.binSize);
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
      stop, t1, t2, rr, rrT1, rrT2, atr, level, t2Synthetic, confluence,
      inputs: {
        price: ctx.price, atr, near: ctx.near, htfZ: ctx.htfZ, profile: ctx.profile, level, confluence,
        targetKinds: [targets[0].kind, t2Synthetic ? 'ATR' : targets[1].kind],
        thresholds: { threshold: cfg.threshold, minConditions: cfg.minConditions, minFamilies: cfg.minFamilies, minRR: r.minRR },
        weights: cfg.weights,
      },
    },
  };
}
