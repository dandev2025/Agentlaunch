import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDirection, type EvalContext } from '../src/signals/evaluate.js';
import { toBigTrade } from '../src/indicators/bigTrades.js';
import type { ProfileSnapshot } from '../src/core/types.js';
import { testConfig, trade } from './helpers.js';

const sc = testConfig().signals;
// Levels: VAL 100, POC 110, VAH 120, HVN 105 & 130
const profile: ProfileSnapshot = {
  ts: 0, poc: 110, val: 100, vah: 120, totalVolume: 1e4, binSize: 1,
  hvns: [{ price: 105, volume: 1 }, { price: 130, volume: 1 }],
};
const T = 1_000_000;
const base = (o: Partial<EvalContext> = {}): EvalContext => ({
  symbol: 'BTCUSDT', ts: T, price: 100.3, atr: 2, near: 1, profile,
  flips: [{ direction: 'LONG', ts: T - 60_000 }],
  divergences: [{ direction: 'LONG', ts: T - 120_000 }],
  bigTrades: [toBigTrade(trade(T - 10_000, 100.1, 10, 'buy'))],
  htfZ: 0, ...o,
});

test('LONG fires with level + flip + divergence + big print; plan is sane', () => {
  const r = evaluateDirection(sc, base(), 'LONG');
  assert.ok(r.ok);
  const c = r.candidate;
  assert.deepEqual(c.conditions.map((x) => x.key).sort(), ['big_prints', 'delta_flip', 'divergence', 'level:VAL']);
  assert.equal(c.score, 25 + 20 + 25 + 25);
  assert.equal(c.stop, 100 - 1.0 * 2); // beyond the level by 1 ATR
  assert.equal(c.t1, 105); // next HVN above entry
  assert.equal(c.t2, 110); // then POC
  assert.ok(c.stop < c.entry && c.entry < c.t1 && c.t1 < c.t2);
  assert.ok(Math.abs(c.rrT1 - (105 - 100.3) / (100.3 - 98)) < 1e-9);
  assert.ok(c.entryLo <= c.entry && c.entry <= c.entryHi);
});

test('requires >= 3 conditions: level + one delta condition is not enough', () => {
  const r = evaluateDirection(sc, base({ divergences: [], bigTrades: [] }), 'LONG');
  assert.ok(!r.ok && r.reason === 'min_conditions');
});

test('one indicator family cannot trigger alone (flip + divergence w/o level)', () => {
  const r = evaluateDirection(sc, base({ price: 114, bigTrades: [] }), 'LONG');
  assert.ok(!r.ok);
  assert.equal(r.reason, 'min_conditions'); // only 2 delta conditions, no level
});

test('min_families blocks 3 conditions from a single family', () => {
  const cfg = { ...sc, minFamilies: 2 };
  // level + flip + divergence = 2 families -> passes; make big_prints absent
  const ok = evaluateDirection(cfg, base({ bigTrades: [] }), 'LONG');
  assert.ok(ok.ok);
  const strict = evaluateDirection({ ...sc, minFamilies: 3 }, base({ bigTrades: [] }), 'LONG');
  assert.ok(!strict.ok && strict.reason === 'min_families');
});

test('below threshold', () => {
  const r = evaluateDirection({ ...sc, threshold: 99 }, base(), 'LONG');
  assert.ok(!r.ok && r.reason === 'below_threshold');
});

test('stale events do not count (ttl)', () => {
  const r = evaluateDirection(sc, base({ flips: [{ direction: 'LONG', ts: T - sc.conditionTtlMs - 1 }], bigTrades: [] }), 'LONG');
  assert.ok(!r.ok && r.reason === 'min_conditions');
});

test('higher-timeframe filter vetoes longs into strong negative 15m delta, and shorts into positive', () => {
  const l = evaluateDirection(sc, base({ htfZ: -2 }), 'LONG');
  assert.ok(!l.ok && l.reason === 'htf_filter');
  assert.ok(evaluateDirection(sc, base({ htfZ: -1 }), 'LONG').ok);
  const sctx = base({
    price: 119.8, flips: [{ direction: 'SHORT', ts: T }], divergences: [{ direction: 'SHORT', ts: T }],
    bigTrades: [toBigTrade(trade(T, 120, 10, 'sell'))], htfZ: 2,
  });
  const s = evaluateDirection(sc, sctx, 'SHORT');
  assert.ok(!s.ok && s.reason === 'htf_filter');
});

test('SHORT is the mirror image at VAH', () => {
  const r = evaluateDirection(sc, base({
    price: 119.8, flips: [{ direction: 'SHORT', ts: T }], divergences: [{ direction: 'SHORT', ts: T }],
    bigTrades: [toBigTrade(trade(T, 120, 10, 'sell'))],
  }), 'SHORT');
  assert.ok(r.ok);
  const c = r.candidate;
  assert.ok(c.conditions.some((k) => k.key === 'level:VAH'));
  assert.equal(c.stop, 122);
  assert.ok(c.stop > c.entry && c.entry > c.t1 && c.t1 > c.t2);
  assert.equal(c.t1, 110); // POC is the next level below
  // and the same context must not produce a LONG
  assert.ok(!evaluateDirection(sc, base({ price: 119.8 }), 'LONG').ok);
});

test('big print against the direction does not count', () => {
  const r = evaluateDirection(sc, base({ bigTrades: [toBigTrade(trade(T, 100, 10, 'sell'))] }), 'LONG');
  assert.ok(r.ok); // still fires on level + flip + divergence...
  assert.ok(!r.candidate.conditions.some((k) => k.key === 'big_prints')); // ...but the opposing print earns no points
  assert.equal(r.candidate.score, 25 + 20 + 25);
  const only = evaluateDirection(sc, base({ divergences: [], bigTrades: [toBigTrade(trade(T, 100, 10, 'sell'))] }), 'LONG');
  assert.ok(!only.ok && only.reason === 'min_conditions');
});

test('min R:R skips poor plans', () => {
  const r = evaluateDirection({ ...sc, risk: { ...sc.risk, minRR: 5 } }, base(), 'LONG');
  assert.ok(!r.ok && r.reason === 'min_rr');
});

test('no targets / no atr / no profile', () => {
  const noTargets: ProfileSnapshot = { ...profile, poc: 100.2, vah: 100.4, hvns: [] };
  const r = evaluateDirection(sc, base({ profile: noTargets }), 'LONG');
  assert.ok(!r.ok && r.reason === 'no_targets');
  assert.equal((evaluateDirection(sc, base({ atr: null }), 'LONG') as any).reason, 'no_atr');
  assert.equal((evaluateDirection(sc, base({ profile: null }), 'LONG') as any).reason, 'no_profile');
});

test('fallback T2 is ATR-projected when only one target exists', () => {
  const p: ProfileSnapshot = { ...profile, poc: 100.2, vah: 100.4, hvns: [{ price: 105, volume: 1 }] };
  const r = evaluateDirection({ ...sc, risk: { ...sc.risk, minRR: 0.1 } }, base({ profile: p }), 'LONG');
  assert.ok(r.ok && r.candidate.t2Synthetic && r.candidate.t2 === 105 + 2);
});

test('weights are configurable', () => {
  const r = evaluateDirection({ ...sc, weights: { ...sc.weights, 'level:VAL': 5 } , threshold: 90 }, base(), 'LONG');
  assert.ok(!r.ok && r.reason === 'below_threshold' && r.score === 75);
});
