import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyMultiplier, familyScores, scoreConfluence, type ConfluenceConfig } from '../src/signals/confluence.js';
import { evaluateDirection, type EvalContext } from '../src/signals/evaluate.js';
import { signalMessage } from '../src/signals/format.js';
import { buildReport, formatReport } from '../src/backtest/report.js';
import { compareRuns, formatComparison } from '../src/backtest/compare.js';
import { runReplay } from '../src/backtest/replay.js';
import { DEFAULT_SYNTH, generateSynthetic } from '../src/backtest/synthetic.js';
import { toBigTrade } from '../src/indicators/bigTrades.js';
import { validateConfig } from '../src/config/load.js';
import { Store } from '../src/db/store.js';
import type { ProfileSnapshot } from '../src/core/types.js';
import { testConfig, trade } from './helpers.js';

const cc: ConfluenceConfig = testConfig().signals.confluence;
const c = (key: string, family: string, points: number) => ({ key, family, points });

test('family collapse: strongest at full value, the rest at stackFactor', () => {
  assert.deepEqual(familyScores([c('delta_flip', 'delta', 20), c('divergence', 'delta', 25), c('l', 'profile', 25)], 0.5), { delta: 35, profile: 25 });
  assert.deepEqual(familyScores([c('a', 'x', 10), c('b', 'x', 10), c('c', 'x', 10)], 0.5), { x: 20 });
  assert.deepEqual(familyScores([c('a', 'x', 10), c('b', 'x', 10)], 0), { x: 10 });
});

test('diversity bonus: largest configured count <= families applies; below the smallest key it is 1', () => {
  const b = { '3': 1.1, '4': 1.2, '5': 1.3 };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => familyMultiplier(b, n)), [1, 1, 1.1, 1.2, 1.3, 1.3]);
});

test('disabled confluence is exactly the old flat sum', () => {
  const r = scoreConfluence({ ...cc, enabled: false }, [c('a', 'delta', 20), c('b', 'delta', 25), c('l', 'profile', 25)], [c('x', 'delta', 99)]);
  assert.equal(r.score, 70);
  assert.equal(r.multiplier, 1);
  assert.equal(r.conflict, 0);
});

test('score = family-collapsed sum x bonus - conflict, floored at 0', () => {
  const conds = [c('level:VAL', 'profile', 25), c('delta_flip', 'delta', 20), c('divergence', 'delta', 25), c('big_prints', 'bigtrades', 25)];
  const r = scoreConfluence(cc, conds);
  assert.equal(r.raw, 95);
  assert.deepEqual(r.familyScores, { profile: 25, delta: 35, bigtrades: 25 });
  assert.equal(r.familyCount, 3);
  assert.equal(r.score, 93.5); // 85 x 1.1
  const withConflict = scoreConfluence(cc, conds, [c('fp_absorption', 'footprint', 25)]);
  assert.equal(withConflict.conflict, 12.5);
  assert.equal(withConflict.score, 81);
  assert.equal(scoreConfluence(cc, conds, [c('x', 'delta', 1000)]).score, 0); // floored, never negative
});

test('only configured families count as opposing evidence; weight 0 disables the penalty', () => {
  const conds = [c('a', 'profile', 25), c('b', 'delta', 20), c('d', 'bigtrades', 25)];
  const opp = [c('level:VAH', 'profile', 25), c('gex_flip', 'gex', 15), c('fp_absorption', 'footprint', 20)];
  const r = scoreConfluence(cc, conds, opp);
  assert.deepEqual(r.conflictConditions.map((k) => k.key), ['fp_absorption']); // profile and gex are excluded
  assert.equal(r.conflict, 10);
  assert.equal(scoreConfluence({ ...cc, conflict: { weight: 0, families: cc.conflict.families } }, conds, opp).conflict, 0);
  assert.equal(scoreConfluence({ ...cc, conflict: { weight: 0.5, families: ['gex'] } }, conds, opp).conflict, 7.5);
});

// ---- integration with the evaluator ------------------------------------------------
const sc = testConfig().signals;
const profile: ProfileSnapshot = { ts: 0, poc: 110, val: 100, vah: 120, totalVolume: 1e4, binSize: 1, hvns: [{ price: 105, volume: 1 }, { price: 130, volume: 1 }] };
const T = 1_000_000;
const base = (o: Partial<EvalContext> = {}): EvalContext => ({
  symbol: 'BTCUSDT', ts: T, price: 100.3, atr: 2, near: 1, profile,
  flips: [{ direction: 'LONG', ts: T - 60_000 }], divergences: [{ direction: 'LONG', ts: T - 120_000 }],
  bigTrades: [toBigTrade(trade(T - 10_000, 100.1, 10, 'buy'))], htfZ: 0, ...o,
});

test('evaluator applies confluence: collapse + bonus, and records the breakdown in the signal inputs', () => {
  const r = evaluateDirection(sc, base(), 'LONG');
  assert.ok(r.ok);
  assert.equal(r.candidate.score, 93.5);
  assert.equal(r.candidate.confluence.raw, 95);
  assert.deepEqual((r.candidate.inputs as any).confluence.familyScores, { profile: 25, delta: 35, bigtrades: 25 });
});

test('opposing evidence subtracts from the score and can push a signal under the threshold', () => {
  const opposing = base({
    flips: [{ direction: 'LONG', ts: T - 60_000 }, { direction: 'SHORT', ts: T - 30_000 }],
    divergences: [{ direction: 'LONG', ts: T - 120_000 }, { direction: 'SHORT', ts: T - 30_000 }],
  });
  const r = evaluateDirection(sc, opposing, 'LONG');
  assert.ok(r.ok);
  assert.equal(r.candidate.confluence.conflict, 17.5); // 0.5 x (25 + 0.5 x 20)
  assert.equal(r.candidate.score, 76);
  assert.deepEqual(r.candidate.confluence.conflictConditions.map((k) => k.key).sort(), ['delta_flip', 'divergence']);
  const strict = { ...sc, threshold: 90 };
  assert.ok(evaluateDirection(strict, base(), 'LONG').ok);
  const f = evaluateDirection(strict, opposing, 'LONG');
  assert.ok(!f.ok && f.reason === 'below_threshold' && f.score === 76);
});

test('opposing evidence needs no level: bearish absorption near price counts against a long', () => {
  const ctx = base({ fpEvents: [{ kind: 'absorption', direction: 'SHORT', ts: T, lo: 99.9, hi: 100.6, detail: {} }] });
  const r = evaluateDirection(sc, ctx, 'LONG');
  assert.ok(r.ok);
  assert.deepEqual(r.candidate.confluence.conflictConditions.map((k) => k.key), ['fp_absorption']);
  assert.equal(r.candidate.score, 81); // 93.5 - 0.5 x 25
  // far from price it does not oppose
  const far = base({ fpEvents: [{ kind: 'absorption', direction: 'SHORT', ts: T, lo: 110, hi: 111, detail: {} }] });
  assert.equal((evaluateDirection(sc, far, 'LONG') as any).candidate.confluence.conflict, 0);
});

test('a level is never "opposing evidence" (POC is support and resistance), and GEX is excluded by default', () => {
  const atPoc = base({ price: 109.8, bigTrades: [toBigTrade(trade(T - 5000, 109.9, 10, 'buy'))] });
  const r = evaluateDirection(sc, atPoc, 'LONG');
  assert.ok(r.ok);
  assert.ok(r.candidate.conditions.some((k) => k.key === 'level:POC'));
  assert.equal(r.candidate.confluence.conflict, 0);
  // price below the flip gives a SHORT gex condition; by default that doesn't oppose a long
  const belowFlip = base({ gex: { underlying: 'BTC', ts: T - 1000, spot: 100, flipLevel: 105, totalGex: -1 } });
  assert.equal((evaluateDirection(sc, belowFlip, 'LONG') as any).candidate.confluence.conflict, 0);
  const gexCounts = { ...sc, confluence: { ...sc.confluence, conflict: { weight: 0.5, families: ['gex'] } } };
  assert.equal((evaluateDirection(gexCounts, belowFlip, 'LONG') as any).candidate.confluence.conflict, 7.5);
});

test('with confluence disabled the evaluator behaves as before (flat score, no opposing pass)', () => {
  const flat = { ...sc, confluence: { ...sc.confluence, enabled: false } };
  const r = evaluateDirection(flat, base(), 'LONG');
  assert.ok(r.ok);
  assert.equal(r.candidate.score, 95);
  assert.equal(r.candidate.confluence.enabled, false);
});

test('Telegram message shows the confluence breakdown', () => {
  const r = evaluateDirection(sc, base({ fpEvents: [{ kind: 'absorption', direction: 'SHORT', ts: T, lo: 99.9, hi: 100.6, detail: {} }] }), 'LONG');
  assert.ok(r.ok);
  const msg = signalMessage(r.candidate, 7);
  assert.match(msg, /Confluence: 3 families \(profile 25 · delta 35 · bigtrades 25\) ×1\.1 · conflict −12\.5 \(fp_absorption\)/);
  assert.match(msg, /score 81/);
});

test('config validation covers confluence settings', () => {
  assert.throws(() => validateConfig(testConfig((x) => { x.signals.confluence.stackFactor = 1.5; })), /stackFactor/);
  assert.throws(() => validateConfig(testConfig((x) => { x.signals.confluence.conflict.weight = -1; })), /conflict\.weight/);
  assert.throws(() => validateConfig(testConfig((x) => { x.signals.confluence.familyBonus = { two: 1.1 } as any; })), /familyBonus/);
  assert.doesNotThrow(() => validateConfig(testConfig((x) => { x.signals.confluence.enabled = false; x.signals.confluence.stackFactor = 9; })));
});

// ---- report & compare ---------------------------------------------------------------
function addSignal(store: Store, o: { ts: number; symbol?: string; dir?: 'LONG' | 'SHORT'; score: number; r: number; conds: [string, string][] }) {
  const id = store.insertSignal({
    ts: o.ts, symbol: o.symbol ?? 'BTCUSDT', direction: o.dir ?? 'LONG', score: o.score, entry: 100, entryLo: 99, entryHi: 101, stop: 98,
    t1: 104, t2: 108, rr: 2, rrT1: 2, rrT2: 4, atr: 2, inputs: {},
    conditions: o.conds.map(([key, family]) => ({ key, family, points: 10 })),
  });
  store.updateSignal(id, { closed: true, outcome: o.r > 0 ? 'T2' : 'STOP', realizedR: o.r, closedTs: o.ts + 1, maxFavorable: 1, maxAdverse: 1, maxFavorableR: 0.5, maxAdverseR: 0.5 });
}

test('report breaks results down by family, score bucket and family count', () => {
  const store = new Store(':memory:').withRun('r');
  addSignal(store, { ts: 1, score: 65, r: 2, conds: [['level:VAL', 'profile'], ['delta_flip', 'delta'], ['big_prints', 'bigtrades']] });
  addSignal(store, { ts: 2, score: 68, r: -1, conds: [['level:VAL', 'profile'], ['delta_flip', 'delta'], ['divergence', 'delta']] });
  addSignal(store, { ts: 3, score: 82, r: 3, conds: [['level:POC', 'profile'], ['delta_flip', 'delta'], ['big_prints', 'bigtrades'], ['fp_absorption', 'footprint']] });
  const rep = buildReport(store, 'r');
  const fam = Object.fromEntries(rep.byFamily.map((f) => [f.key, f]));
  assert.equal(fam.delta.n, 3);
  assert.equal(fam.footprint.n, 1);
  assert.equal(fam.footprint.avgR, 3);
  assert.equal(fam.bigtrades.nWithout, 1);
  assert.equal(fam.bigtrades.avgRWithout, -1);
  assert.deepEqual(rep.byScoreBucket.map((b) => [b.bucket, b.n, +b.avgR.toFixed(2)]), [['60-69', 2, 0.5], ['80-89', 1, 3]]);
  assert.deepEqual(Object.fromEntries(Object.entries(rep.byFamilyCount).map(([k, v]) => [k, v.n])), { 2: 1, 3: 1, 4: 1 }); // 2 = profile+delta
  const text = formatReport(rep);
  assert.match(text, /Per indicator family/);
  assert.match(text, /By score/);
  assert.match(text, /60-69/);
});

test('compare matches signals by symbol/direction/time and splits common vs only-in-one', () => {
  const store = new Store(':memory:');
  const a = store.withRun('A'), b = store.withRun('B');
  addSignal(a, { ts: 100, score: 70, r: 2, conds: [['l', 'profile']] });
  addSignal(b, { ts: 100, score: 66, r: 2, conds: [['l', 'profile']] }); // same signal in both
  addSignal(a, { ts: 200, score: 61, r: -1, conds: [['l', 'profile']] }); // only A (B's score fell under threshold)
  addSignal(a, { ts: 300, score: 90, r: 3, symbol: 'ETHUSDT', conds: [['l', 'profile']] }); // only A, other symbol
  addSignal(b, { ts: 400, score: 75, r: 1, dir: 'SHORT', conds: [['l', 'profile']] }); // only B
  addSignal(b, { ts: 100, score: 75, r: 1, dir: 'SHORT', conds: [['l', 'profile']] }); // same ts but other direction -> only B
  const c = compareRuns(store, 'A', 'B');
  assert.equal(c.common.n, 1);
  assert.deepEqual([c.onlyA.n, c.onlyB.n], [2, 2]);
  assert.equal(c.onlyA.totalR, 2); // -1 + 3
  assert.deepEqual([c.overall.a.n, c.overall.b.n], [3, 3]);
  assert.match(formatComparison(c), /only in A \(B skipped them\)\s+2/);
  assert.match(formatComparison(c), /cooldowns shift later signals/);
});

test('replay with confluence on vs off: same trades, scores recorded consistently, compare reconciles', () => {
  const store = new Store(':memory:');
  store.insertTrades([...generateSynthetic(DEFAULT_SYNTH, Date.parse('2026-01-01T00:00:00Z'), 8, 7)]);
  runReplay(store, testConfig(), { runId: 'on' });
  runReplay(store, testConfig((x) => { x.signals.confluence.enabled = false; }), { runId: 'off' });
  const rows = (run: string) => store.db.prepare('SELECT score, inputs FROM signals WHERE run_id = ?').all(run) as { score: number; inputs: string }[];
  const on = rows('on'), off = rows('off');
  assert.ok(on.length > 0 && off.length > 0);
  for (const s of on) {
    const cf = JSON.parse(s.inputs).confluence;
    assert.equal(cf.enabled, true);
    assert.equal(cf.score, s.score);
    assert.ok(cf.multiplier >= 1 && cf.score >= 60 && cf.raw > 0);
  }
  for (const s of off) {
    const cf = JSON.parse(s.inputs).confluence;
    assert.equal(cf.enabled, false);
    assert.equal(cf.score, cf.raw);
    assert.equal(cf.score, s.score);
  }
  const cmp = compareRuns(store, 'off', 'on');
  assert.equal(cmp.common.n + cmp.onlyA.n, cmp.overall.a.n);
  assert.equal(cmp.common.n + cmp.onlyB.n, cmp.overall.b.n);
  assert.ok(Math.abs(cmp.common.a.totalR - cmp.common.b.totalR) < 1e-9, 'identical trades must give identical outcomes for the same signal');
});
