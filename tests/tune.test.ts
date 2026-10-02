import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, formatTune, round2, thresholdForRate } from '../src/tune/analyze.js';
import { Store } from '../src/db/store.js';
import { Pipeline } from '../src/engine/pipeline.js';
import { MemoryNotifier } from '../src/alerts/notifier.js';
import { testConfig, trade } from './helpers.js';

const cfg = testConfig((c) => { c.assets.ETHUSDT.enabled = false; c.assets.SOLUSDT.enabled = false; });
const T0 = 1_000_000_000;
const HOUR = 3_600_000;

function seeded() {
  const store = new Store(':memory:');
  // 2 hours, one trade per second, sizes 0.01 .. 72.00 (all distinct, so quantiles are exact)
  store.insertTrades(Array.from({ length: 7200 }, (_, i) => ({ symbol: 'BTCUSDT', aggId: i + 1, ts: T0 + i * 1000, price: 100, size: (i + 1) / 100, side: 'buy' as const })));
  // 10 walls: 4 flash (10s), 6 lasting 2 minutes with peaks 100..600
  const wall = (price: number, lived: number, peak: number, status: string) => {
    const id = store.insertWall({ symbol: 'BTCUSDT', side: 'bid', price, ts: T0 + 60_000, size: peak });
    store.updateWall(id, { ts: T0 + 60_000 + lived, size: 5, peak, executed: 0, status });
  };
  for (let i = 0; i < 4; i++) wall(100 + i, 10_000, 120, 'pulled');
  [100, 200, 300, 400, 500, 600].forEach((p, i) => wall(200 + i, 120_000, p, i % 2 ? 'eaten' : 'pulled'));
  for (let i = 0; i < 24; i++) store.recordAlert(T0 + i * 60_000, 'BTCUSDT', 'big_trade_at_level', 'm', {});
  for (let i = 0; i < 6; i++) store.recordAlert(T0 + i * 60_000, 'BTCUSDT', 'delta_divergence', 'm', {});
  return store;
}

test('round2 and thresholdForRate', () => {
  assert.equal(round2(71.77), 72);
  assert.equal(round2(0.04567), 0.046);
  assert.equal(round2(1234), 1200);
  assert.equal(round2(0), 0);
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(thresholdForRate(sorted, 1, 10), 91); // the 10 biggest are 91..100
  assert.equal(thresholdForRate(sorted, 2, 10), 81); // 20 in two hours
  assert.equal(thresholdForRate([], 1, 10), 0);
});

test('size percentiles, big-trade rate now and suggested threshold for the target rate', () => {
  const r = analyze(seeded(), cfg, { now: T0 + 2 * HOUR });
  const s = r.symbols[0];
  assert.ok(Math.abs(r.hours - 2) < 0.01);
  assert.ok(Math.abs(s.tradesPerHour - 3600) < 5);
  assert.ok(Math.abs(s.size.p50 - 36) < 0.1 && Math.abs(s.size.p99 - 71.28) < 0.1 && s.size.max === 72);
  // config threshold for BTC is 3: sizes >= 3 are 7200 - 299 = 6901 trades in 2h
  assert.equal(s.big.minQty, 3);
  assert.ok(Math.abs(s.big.perHour - 6901 / 2) < 1);
  // target 12/hour over 2 hours = 24 trades: about the 24 largest (71.77..72.00), so ~72
  assert.ok(s.big.suggestedMinQty >= 71 && s.big.suggestedMinQty <= 73, `suggested ${s.big.suggestedMinQty}`);
  assert.ok(s.big.suggestedPerHour <= 12 && s.big.suggestedPerHour >= 0);
});

test('walls: rate, flash share, lasting walls and a raised-threshold suggestion only when there are too many', () => {
  const store = seeded();
  const w = analyze(store, cfg, { now: T0 + 2 * HOUR }).symbols[0].walls;
  assert.equal(w.total, 10);
  assert.ok(Math.abs(w.perHour - 5) < 0.05);
  assert.equal(w.flashShare, 0.4);
  assert.ok(Math.abs(w.steadyPerHour - 3) < 0.05);
  assert.deepEqual(w.byStatus, { pulled: 7, eaten: 3 });
  assert.equal(w.suggestedMinQty, null); // 3 lasting/hour is already under the 6/hour target
  // ask for only 1 lasting wall/hour: keep the 2 biggest of the 6 -> threshold = 500
  assert.equal(analyze(store, cfg, { now: T0 + 2 * HOUR, targets: { steadyWallsPerHour: 1 } }).symbols[0].walls.suggestedMinQty, 500);
});

test('alerts per hour by type; chatty is flagged in the text report', () => {
  const r = analyze(seeded(), cfg, { now: T0 + 2 * HOUR });
  const a = r.symbols[0].alerts;
  assert.equal(a.total, 30);
  assert.ok(Math.abs(a.perHour - 15) < 0.1);
  assert.deepEqual(a.byType, { big_trade_at_level: 24, delta_divergence: 6 });
  const text = formatTune(r);
  assert.match(text, /== BTCUSDT ==/);
  assert.match(text, /chattier than ~6\/hour/);
  assert.match(text, /assets\.BTCUSDT\.bigTrade\.minQty = 7\d/);
  assert.match(text, /already gives ≤ 6 lasting walls\/hour/);
  assert.match(text, /Suggestions only match event \*rates\*/);
});

test('little data and empty assets do not crash, and a short history is called out', () => {
  const empty = analyze(new Store(':memory:'), testConfig(), { now: T0 });
  assert.equal(empty.symbols.length, 3);
  assert.equal(empty.symbols[0].trades, 0);
  assert.equal(empty.hasData, false);
  assert.match(formatTune(empty), /No trades are stored yet/);
  // a short history is called out
  const short = new Store(':memory:');
  short.insertTrades(Array.from({ length: 600 }, (_, i) => ({ symbol: 'BTCUSDT', aggId: i + 1, ts: T0 + i * 1000, price: 100, size: 1, side: 'buy' as const })));
  assert.match(formatTune(analyze(short, cfg, { now: T0 + 600_000 })), /Under 3 hours of data/);
});

test('signal diagnostics: warming-up and no-ATR evaluations are counted, so "no signals" is explainable', () => {
  const p = new Pipeline(cfg, { store: new Store(':memory:'), notifier: new MemoryNotifier() });
  const e = p.engines.get('BTCUSDT')!;
  // 10 minutes of trades with minute boundaries: engine is not yet warm (30 min) -> evaluations are skipped as warming_up
  for (let i = 0; i < 10 * 60; i++) p.onTrade(trade(T0 + i * 1000, 100, 1, i % 2 ? 'buy' : 'sell'));
  assert.ok(e.stats.rejected.warming_up >= 8, JSON.stringify(e.stats.rejected));
  assert.equal(e.stats.evaluations, 0);
  // 40 minutes in: warm, but only 8 closed 5m candles -> ATR (14) not ready
  for (let i = 10 * 60; i < 40 * 60; i++) p.onTrade(trade(T0 + i * 1000, 100, 1, i % 2 ? 'buy' : 'sell'));
  assert.ok(e.stats.evaluations > 0);
  assert.ok(e.stats.rejected.no_atr > 0);
});
