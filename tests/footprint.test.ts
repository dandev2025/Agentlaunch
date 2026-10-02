import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAbsorption, detectStackedImbalance, FootprintBuilder, imbalanceMarks, type FootprintOptions } from '../src/indicators/footprint.js';
import { evaluateDirection, type EvalContext } from '../src/signals/evaluate.js';
import { runReplay } from '../src/backtest/replay.js';
import { DEFAULT_SYNTH, generateSynthetic } from '../src/backtest/synthetic.js';
import { Store } from '../src/db/store.js';
import { validateConfig } from '../src/config/load.js';
import type { FootprintCandle, FootprintLevel, ProfileSnapshot } from '../src/core/types.js';
import { testConfig, trade } from './helpers.js';

const opts: FootprintOptions = testConfig().footprint;

/** Dense footprint from [bid, ask] pairs, ascending from price 100 in steps of 1. */
function fcOf(rows: [number, number][], close?: number): FootprintCandle {
  const levels: FootprintLevel[] = rows.map(([bid, ask], i) => ({ price: 100 + i, bid, ask, trades: 1 }));
  return {
    symbol: 'BTCUSDT', tf: '5m', ts: 0, open: 100 + rows.length / 2, high: 100 + rows.length - 1, low: 100,
    close: close ?? 100 + rows.length / 2, binSize: 1, levels,
    totalBid: rows.reduce((a, r) => a + r[0], 0), totalAsk: rows.reduce((a, r) => a + r[1], 0),
  };
}

test('builder: aggressive buys go to ask, sells to bid, per price bin; dense levels; OHLC', () => {
  const b = new FootprintBuilder('BTCUSDT', '1m', 1);
  b.add(trade(1_000, 100.2, 2, 'buy'));
  b.add(trade(2_000, 100.4, 1, 'sell')); // same bin as 100
  b.add(trade(3_000, 102.0, 3, 'sell')); // skips bin 101 -> must exist with zeros
  const fc = b.add(trade(61_000, 99, 1, 'buy'))!;
  assert.deepEqual(fc.levels.map((l) => [l.price, l.bid, l.ask]), [[100, 1, 2], [101, 0, 0], [102, 3, 0]]);
  assert.equal(fc.totalAsk, 2);
  assert.equal(fc.totalBid, 4);
  assert.deepEqual([fc.open, fc.high, fc.low, fc.close], [100.2, 102, 100.2, 102]);
});

test('diagonal imbalance: ask[i] vs bid[i-1], bid[i] vs ask[i+1]; edges skipped; zero opposite counts', () => {
  // idx: 0     1      2      3
  const fc = fcOf([[10, 5], [4, 30], [40, 4], [5, 1]]);
  const m = imbalanceMarks(fc, { imbalanceRatio: 3, minVolFrac: 0 });
  // buy @1: 30 >= 3*bid[0]=30 ✓ ; buy @2: 4 vs 3*4 ✗ ; buy @3: 1 ✗
  // sell @2: 40 >= 3*ask[3]=3 ✓ ; sell @1: 4 vs 3*ask[2]=12 ✗ ; sell @0: 10 >= 3*30 ✗
  assert.deepEqual(m, [{ index: 1, side: 'buy' }, { index: 2, side: 'sell' }]);
  // minVolFrac filters noise: with 50% required nothing qualifies
  assert.deepEqual(imbalanceMarks(fc, { imbalanceRatio: 3, minVolFrac: 0.5 }), []);
});

test('stacked buy imbalance needs >= stackedMin consecutive levels', () => {
  // asks at idx1..3 each >= 3x bid below; idx4 breaks the run
  const rows: [number, number][] = [[10, 0], [10, 40], [10, 40], [10, 40], [10, 5], [10, 5]];
  const ev = detectStackedImbalance(fcOf(rows), { ...opts, minVolFrac: 0 });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].direction, 'LONG');
  assert.deepEqual([ev[0].lo, ev[0].hi, (ev[0].detail as any).levels], [101, 103, 3]);
  // only two in a row -> nothing
  const two: [number, number][] = [[10, 0], [10, 40], [10, 40], [10, 5], [10, 5]];
  assert.deepEqual(detectStackedImbalance(fcOf(two), { ...opts, minVolFrac: 0 }), []);
});

test('stacked sell imbalance maps to SHORT', () => {
  const rows: [number, number][] = [[5, 5], [40, 10], [40, 10], [40, 10], [5, 10]];
  // sell @i: bid[i] >= 3*ask[i+1]: i=1: 40>=30 ✓, i=2 ✓, i=3: 40 >= 3*10 ✓
  const ev = detectStackedImbalance(fcOf(rows), { ...opts, minVolFrac: 0 });
  assert.deepEqual(ev.map((e) => e.direction), ['SHORT']);
  assert.equal((ev[0].detail as any).levels, 3);
});

// 10 levels: heavy selling in the bottom 30% (idx 0-2), price closes back up
const sellAbsorb = (close: number) =>
  fcOf([[200, 20], [250, 30], [150, 10], [20, 20], [20, 20], [20, 20], [20, 20], [20, 20], [20, 20], [20, 20]], close);

test('sell absorption (bullish): dominant selling at the low, high volume, close back up', () => {
  const ev = detectAbsorption(sellAbsorb(107), 500, opts);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].direction, 'LONG');
  assert.equal((ev[0].detail as any).type, 'sell_absorption');
  assert.deepEqual([ev[0].lo, ev[0].hi], [100, 102]);
});

test('absorption needs rejection, elevated volume and a warm average', () => {
  assert.deepEqual(detectAbsorption(sellAbsorb(101), 500, opts), []); // closed at the lows: not rejected
  assert.deepEqual(detectAbsorption(sellAbsorb(107), 5000, opts), []); // volume not elevated vs average
  assert.deepEqual(detectAbsorption(sellAbsorb(107), null, opts), []); // average not available yet
});

test('buy absorption (bearish) mirrors at the high', () => {
  const rows: [number, number][] = [[20, 20], [20, 20], [20, 20], [20, 20], [20, 20], [20, 20], [20, 20], [10, 150], [30, 250], [20, 200]];
  const ev = detectAbsorption(fcOf(rows, 102), 500, opts);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].direction, 'SHORT');
  assert.equal((ev[0].detail as any).type, 'buy_absorption');
});

// ---- signal integration ------------------------------------------------------
// These tests assert which conditions fire and exact point sums, so they pin the legacy flat scoring; confluence has its own tests.
const sc = testConfig((c) => { c.signals.confluence.enabled = false; }).signals;
const profile: ProfileSnapshot = { ts: 0, poc: 110, val: 100, vah: 120, totalVolume: 1e4, binSize: 1, hvns: [{ price: 105, volume: 1 }, { price: 130, volume: 1 }] };
const T = 1_000_000;
const ctx = (o: Partial<EvalContext> = {}): EvalContext => ({
  symbol: 'BTCUSDT', ts: T, price: 100.3, atr: 2, near: 1, profile, flips: [], divergences: [], bigTrades: [], htfZ: 0,
  fpEvents: [
    { kind: 'stacked_imbalance', direction: 'LONG', ts: T - 1000, lo: 99.5, hi: 101, detail: {} },
    { kind: 'absorption', direction: 'LONG', ts: T - 1000, lo: 99, hi: 100.5, detail: {} },
  ], ...o,
});

test('footprint conditions form a third family: level + imbalance + absorption fires a LONG', () => {
  const r = evaluateDirection(sc, ctx(), 'LONG');
  assert.ok(r.ok);
  assert.deepEqual(r.candidate.conditions.map((c) => c.key).sort(), ['fp_absorption', 'fp_stacked_imbalance', 'level:VAL']);
  assert.equal(r.candidate.score, 25 + 20 + 25);
  assert.deepEqual([...new Set(r.candidate.conditions.map((c) => c.family))].sort(), ['footprint', 'profile']);
});

test('footprint-only (no level) cannot fire: location required by default, standalone allowed by config', () => {
  const far = ctx({ price: 114 }); // no level within near
  const r = evaluateDirection(sc, far, 'LONG');
  assert.ok(!r.ok && r.reason === 'min_conditions' && r.conditions.length === 0);
  const loose = evaluateDirection(sc, far, 'LONG', { requireAtLevel: false });
  assert.ok(!loose.ok && loose.reason === 'min_conditions'); // two fp conditions alone are still < 3 and single family
  assert.equal(loose.conditions.length, 2);
});

test('footprint zone away from the level does not count; wrong direction does not count', () => {
  const away = ctx({ fpEvents: [{ kind: 'absorption', direction: 'LONG', ts: T, lo: 103, hi: 104, detail: {} }] });
  assert.ok(!evaluateDirection(sc, away, 'LONG').ok);
  assert.equal((evaluateDirection(sc, away, 'LONG') as any).conditions.some((c: any) => c.key === 'fp_absorption'), false);
  const wrong = evaluateDirection(sc, ctx(), 'SHORT');
  assert.ok(!wrong.ok);
  assert.ok(!(wrong as any).conditions.some((c: any) => c.family === 'footprint'));
});

test('config validation covers footprint settings', () => {
  assert.throws(() => validateConfig(testConfig((c) => { c.footprint.timeframes = ['5m']; c.timeframes = ['1m', '15m']; })), /footprint timeframe 5m/);
  assert.throws(() => validateConfig(testConfig((c) => { c.footprint.stackedMin = 1; })), /stackedMin/);
  assert.throws(() => validateConfig(testConfig((c) => { c.assets.BTCUSDT.footprintBin = 0; })), /footprintBin/);
  assert.doesNotThrow(() => validateConfig(testConfig((c) => { c.footprint.enabled = false; c.assets.BTCUSDT.footprintBin = 0; })));
});

test('store persists footprint levels; replay logs footprint events with inputs; disabling turns it off', () => {
  const store = new Store(':memory:');
  const cfg = testConfig();
  store.insertTrades([...generateSynthetic(DEFAULT_SYNTH, Date.parse('2026-01-01T00:00:00Z'), 8, 7)]);
  const on = runReplay(store, cfg, { runId: 'on' });
  const rows = store.db.prepare("SELECT * FROM footprint_events WHERE run_id='on'").all() as any[];
  assert.ok(rows.length > 0);
  assert.equal(rows.length, Object.values(on.perSymbol).reduce((a, p: any) => a + p.footprintEvents, 0));
  for (const r of rows) {
    assert.ok(r.lo <= r.hi);
    assert.ok(Object.keys(JSON.parse(r.detail)).length > 0);
  }
  const off = runReplay(store, testConfig((c) => { c.footprint.enabled = false; }), { runId: 'off' });
  assert.equal(Object.values(off.perSymbol).reduce((a, p: any) => a + p.footprintEvents, 0), 0);

  // direct persistence round-trip
  const b = new FootprintBuilder('BTCUSDT', '1m', 1);
  b.add(trade(1000, 100, 2, 'buy'));
  store.recordFootprint(b.add(trade(61_000, 100, 1))!);
  const lv = store.db.prepare("SELECT price, bid_volume, ask_volume FROM footprint_levels WHERE symbol='BTCUSDT'").all() as any[];
  assert.deepEqual(lv.map((l) => [l.price, l.bid_volume, l.ask_volume]), [[100, 0, 2]]);
});
