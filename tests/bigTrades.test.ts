import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BigTradeBuffer, isBigTrade, toBigTrade } from '../src/indicators/bigTrades.js';
import { trade } from './helpers.js';

test('threshold by qty and/or notional', () => {
  assert.equal(isBigTrade(trade(0, 100, 5), { minQty: 5, minNotionalUsd: null }), true);
  assert.equal(isBigTrade(trade(0, 100, 4.99), { minQty: 5, minNotionalUsd: null }), false);
  assert.equal(isBigTrade(trade(0, 100, 4), { minQty: null, minNotionalUsd: 400 }), true);
  assert.equal(isBigTrade(trade(0, 100, 4), { minQty: 10, minNotionalUsd: 400 }), true); // either triggers
});

test('buffer keeps only the window', () => {
  const buf = new BigTradeBuffer(1000);
  buf.add(toBigTrade(trade(0, 100, 1)));
  buf.add(toBigTrade(trade(900, 100, 1)));
  assert.equal(buf.recent(950).length, 2);
  assert.equal(buf.recent(1500).length, 1);
});
