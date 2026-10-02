import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CandleBuilder } from '../src/indicators/candles.js';
import { Atr } from '../src/indicators/atr.js';
import { candle, trade } from './helpers.js';

test('per-candle delta, cumulative delta and rollover', () => {
  const b = new CandleBuilder('BTCUSDT', '1m');
  assert.equal(b.add(trade(1_000, 100, 2, 'buy')), null);
  assert.equal(b.add(trade(30_000, 101, 1, 'sell')), null);
  const closed = b.add(trade(61_000, 99, 4, 'sell'));
  assert.ok(closed);
  assert.equal(closed.ts, 0);
  assert.deepEqual([closed.open, closed.high, closed.low, closed.close], [100, 101, 100, 101]);
  assert.equal(closed.delta, 1);
  assert.equal(closed.cvd, 1);
  assert.equal(closed.buyVolume, 2);
  assert.equal(closed.sellVolume, 1);
  assert.equal(b.current!.delta, -4);
  assert.equal(b.cumulativeDelta, -3);
  assert.equal(b.current!.cvd, -3);
});

test('empty intervals produce no candles; late trades fold into current', () => {
  const b = new CandleBuilder('BTCUSDT', '1m');
  b.add(trade(1_000, 100, 1));
  const c = b.add(trade(10 * 60_000 + 5, 100, 1));
  assert.equal(c!.ts, 0);
  assert.equal(b.history.length, 1);
  b.add(trade(5_000, 100, 1)); // late
  assert.equal(b.current!.trades, 2);
});

test('ATR: null until period candles, then Wilder smoothing', () => {
  const a = new Atr(3);
  assert.equal(a.update(candle({ high: 11, low: 9, close: 10 })), null);
  assert.equal(a.update(candle({ high: 12, low: 10, close: 11 })), null);
  assert.equal(a.update(candle({ high: 13, low: 11, close: 12 })), 2);
  const v = a.update(candle({ high: 16, low: 12, close: 15 })); // TR = max(4, 4, 0) = 4
  assert.ok(Math.abs(v! - (2 * 2 + 4) / 3) < 1e-9);
});
