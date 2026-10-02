export interface ScoredCondition {
  key: string;
  family: string;
  points: number;
}

export interface ConfluenceConfig {
  enabled: boolean;
  /** Within one family, the strongest condition counts fully and each further one counts at this fraction. */
  stackFactor: number;
  /** Multiplier by number of agreeing families: the entry with the largest key <= count applies (default 1). */
  familyBonus: Record<string, number>;
  conflict: {
    /** Fraction of the opposing direction's (family-collapsed) score subtracted from this direction's score. */
    weight: number;
    /** Only these families count as opposing evidence. */
    families: string[];
  };
}

export interface ConfluenceResult {
  enabled: boolean;
  /** Flat sum of condition points (what the score was before confluence existed). */
  raw: number;
  familyScores: Record<string, number>;
  familyCount: number;
  multiplier: number;
  conflict: number;
  conflictConditions: ScoredCondition[];
  score: number;
}

/** Strongest condition per family at full value, the rest at `stackFactor`. */
export function familyScores(conds: ScoredCondition[], stackFactor: number): Record<string, number> {
  const by = new Map<string, number[]>();
  for (const c of conds) by.set(c.family, [...(by.get(c.family) ?? []), c.points]);
  const out: Record<string, number> = {};
  for (const [fam, pts] of by) {
    const sorted = [...pts].sort((a, b) => b - a);
    out[fam] = sorted[0] + stackFactor * sorted.slice(1).reduce((a, b) => a + b, 0);
  }
  return out;
}

export function familyMultiplier(bonus: Record<string, number>, count: number): number {
  let best = 1, bestKey = -1;
  for (const [k, v] of Object.entries(bonus)) {
    const n = Number(k);
    if (n <= count && n > bestKey) { bestKey = n; best = v; }
  }
  return best;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * score = (sum of family scores) x (bonus for how many families agree) - conflict.weight x (opposing evidence).
 * With `enabled: false` the score is the flat sum of points, exactly as before.
 */
export function scoreConfluence(cfg: ConfluenceConfig, conds: ScoredCondition[], opposing: ScoredCondition[] = []): ConfluenceResult {
  const raw = conds.reduce((s, c) => s + c.points, 0);
  const fam = familyScores(conds, cfg.stackFactor);
  const familyCount = Object.keys(fam).length;
  if (!cfg.enabled) {
    return { enabled: false, raw, familyScores: fam, familyCount, multiplier: 1, conflict: 0, conflictConditions: [], score: raw };
  }
  const multiplier = familyMultiplier(cfg.familyBonus, familyCount);
  const conflictConditions = opposing.filter((c) => cfg.conflict.families.includes(c.family));
  const oppScore = Object.values(familyScores(conflictConditions, cfg.stackFactor)).reduce((a, b) => a + b, 0);
  const conflict = cfg.conflict.weight * oppScore;
  const sum = Object.values(fam).reduce((a, b) => a + b, 0);
  return {
    enabled: true, raw, familyScores: fam, familyCount, multiplier, conflict: r1(conflict),
    conflictConditions: conflictConditions.map(({ key, family, points }) => ({ key, family, points })),
    score: Math.max(0, r1(sum * multiplier - conflict)),
  };
}
