import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDeltaFlip, detectDivergence, htfDeltaZ } from '../src/indicators/divergence.js';
import { candle } from './helpers.js';

const base = Array.from({ length: 5 }, (_, i) => candle({ ts: i, high: 100 + i, low: 90 + i, cvd: 10 * i, delta: 10 }));

test('bearish: new price high, CVD lower than at prior high', () => {
  const h = [...base, candle({ ts: 5, high: 106, low: 95, cvd: 20, delta: -5 })];
  const d = detectDivergence(h, 5);
  assert.equal(d.length, 1);
  assert.equal(d[0].type, 'bearish');
  assert.equal(d[0].refPrice, 104);
  assert.equal(d[0].refCvd, 40);
});

test('no divergence when delta confirms the new high', () => {
  const h = [...base, candle({ ts: 5, high: 106, low: 95, cvd: 60 })];
  assert.deepEqual(detectDivergence(h, 5), []);
});

test('bullish: new price low, CVD higher than at prior low', () => {
  const lows = Array.from({ length: 5 }, (_, i) => candle({ ts: i, high: 110 - i, low: 100 - i * 2, cvd: -10 * i }));
  const d = detectDivergence([...lows, candle({ ts: 5, high: 100, low: 85, cvd: -20 })], 5);
  assert.equal(d.length, 1);
  assert.equal(d[0].type, 'bullish');
});

test('not enough history -> nothing', () => {
  assert.deepEqual(detectDivergence(base.slice(0, 3), 5), []);
});

test('delta flip needs sign change and size', () => {
  const hist = [...Array.from({ length: 10 }, (_, i) => candle({ ts: i, delta: i % 2 ? 10 : 12 })), candle({ ts: 10, delta: -20 }), candle({ ts: 11, delta: 15 })];
  const f = detectDeltaFlip(hist, 20, 0.5);
  assert.equal(f?.direction, 'LONG');
  const small = [...hist.slice(0, -1), candle({ ts: 11, delta: 2 })];
  assert.equal(detectDeltaFlip(small, 20, 0.5), null);
  const same = [...hist.slice(0, -2), candle({ ts: 10, delta: 20 }), candle({ ts: 11, delta: 30 })];
  assert.equal(detectDeltaFlip(same, 20, 0.5), null);
});

test('htf z-score signs and warm-up', () => {
  const neg = Array.from({ length: 20 }, (_, i) => candle({ ts: i, delta: i >= 16 ? -50 : 10 }));
  assert.ok(htfDeltaZ(neg, 4, 48, 12)! < -1.5);
  assert.equal(htfDeltaZ(neg.slice(0, 5), 4, 48, 12), null);
});
