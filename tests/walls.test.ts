import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WallTracker } from '../src/indicators/walls.js';
import { WallTimeline } from '../src/backtest/wallTimeline.js';
import type { AggregatedBook } from '../src/collector/orderbook.js';
import { trade } from './helpers.js';

const opts = { minQty: 100, relMult: 4, dropFrac: 0.2, eatenFrac: 0.5, changeFrac: 0.25 };
const book = (bids: Record<number, number>, asks: Record<number, number>, over: Partial<AggregatedBook> = {}): AggregatedBook => ({
  binSize: 1, mid: 100, minBin: 90, maxBin: 110,
  bids: new Map(Object.entries(bids).map(([k, v]) => [Number(k), v])),
  asks: new Map(Object.entries(asks).map(([k, v]) => [Number(k), v])), ...over,
});
const small = { 99: 10, 98: 12, 96: 9 };
const asksSmall = { 101: 10, 102: 11, 104: 9 };
const types = (evs: { type: string }[]) => evs.map((e) => e.type);

test('adds a wall above max(minQty, relMult x median); small levels and sub-threshold sizes are ignored', () => {
  const t = new WallTracker('X', opts);
  const ev = t.update(0, book({ ...small, 97: 150 }, asksSmall));
  assert.deepEqual(types(ev), ['added']);
  assert.deepEqual([ev[0].wall.side, ev[0].wall.price, ev[0].wall.size], ['bid', 97, 150]);
  assert.deepEqual(types(t.update(1000, book({ ...small, 97: 150 }, asksSmall))), []); // nothing new
  // 150 is not a wall in a book where the median level is 50 (threshold 200)
  const thick = new WallTracker('X', opts);
  assert.deepEqual(thick.update(0, book({ 99: 50, 98: 50, 97: 150 }, { 101: 50, 102: 50 })), []);
});

test('changed events respect changeFrac; peak tracks the maximum', () => {
  const t = new WallTracker('X', opts);
  t.update(0, book({ ...small, 97: 150 }, asksSmall));
  assert.deepEqual(types(t.update(1000, book({ ...small, 97: 170 }, asksSmall))), []); // +13%
  assert.deepEqual(types(t.update(2000, book({ ...small, 97: 210 }, asksSmall))), ['changed']); // +40% vs 150
  const w = t.active()[0];
  assert.deepEqual([w.size, w.peak], [210, 210]);
});

test('ended wall: pulled when not traded into, eaten when executed volume >= eatenFrac x peak', () => {
  const pulled = new WallTracker('X', opts);
  pulled.update(0, book({ ...small, 97: 150 }, asksSmall));
  pulled.onTrade(trade(500, 97, 20, 'sell')); // only 20 of 150
  const p = pulled.update(60_000, book(small, asksSmall));
  assert.deepEqual(types(p), ['pulled']);
  assert.equal(p[0].detail.spoofLike, false);
  assert.equal(pulled.active().length, 0);

  const eaten = new WallTracker('X', opts);
  eaten.update(0, book({ ...small, 97: 150 }, asksSmall));
  eaten.onTrade(trade(500, 97, 40, 'sell'));
  eaten.onTrade(trade(600, 97, 40, 'sell')); // 80 >= 75
  eaten.onTrade(trade(700, 97, 500, 'buy')); // wrong aggressor side: ignored
  assert.deepEqual(types(eaten.update(60_000, book(small, asksSmall))), ['eaten']);
});

test('sweeping through a wall counts as eaten; quick untraded cancel is flagged spoof-like', () => {
  const swept = new WallTracker('X', opts);
  swept.update(0, book({ ...small, 97: 150 }, asksSmall));
  swept.onTrade(trade(500, 96, 1, 'sell')); // printed below the wall
  assert.deepEqual(types(swept.update(5000, book(small, asksSmall))), ['eaten']);

  const spoof = new WallTracker('X', opts);
  spoof.update(0, book({ ...small, 97: 150 }, asksSmall));
  const ev = spoof.update(3000, book(small, asksSmall));
  assert.deepEqual([ev[0].type, ev[0].detail.spoofLike], ['pulled', true]);
});

test('ask walls mirror: buyers eat them, price printing above sweeps them', () => {
  const t = new WallTracker('X', opts);
  const asks = { ...asksSmall, 105: 200 };
  assert.equal(t.update(0, book(small, asks))[0].wall.side, 'ask');
  t.onTrade(trade(100, 105, 120, 'buy'));
  assert.deepEqual(types(t.update(60_000, book(small, asksSmall))), ['eaten']);
});

test('walls leaving the tracked range or on desync expire (no intent implied)', () => {
  const t = new WallTracker('X', opts);
  t.update(0, book({ ...small, 97: 150 }, asksSmall));
  const ev = t.update(1000, book(small, asksSmall, { minBin: 98 })); // range moved up; aggregate() no longer returns bin 97
  assert.deepEqual(types(ev), ['expired']);
  assert.equal(ev[0].detail.reason, 'out_of_range');
  const t2 = new WallTracker('X', opts);
  t2.update(0, book({ ...small, 97: 150 }, asksSmall));
  assert.deepEqual(types(t2.expireAll(5000)), ['expired']);
  assert.equal(t2.active().length, 0);
});

test('timeline: wall is standing between first_seen and its end, with size from events', () => {
  const rows = [
    { id: 1, symbol: 'X', side: 'bid' as const, price: 97, firstSeen: 1000, lastSeen: 9000, peak: 300, lastSize: 20, status: 'pulled', executed: 0 },
    { id: 2, symbol: 'X', side: 'ask' as const, price: 105, firstSeen: 2000, lastSeen: 3000, peak: 150, lastSize: 150, status: 'active', executed: 0 },
  ];
  const events = [
    { wallId: 1, ts: 1000, type: 'added', size: 200 },
    { wallId: 1, ts: 4000, type: 'changed', size: 300 },
    { wallId: 1, ts: 7000, type: 'changed', size: 90 },
    { wallId: 1, ts: 9000, type: 'pulled', size: 20 },
  ];
  const tl = new WallTimeline(rows, events);
  assert.equal(tl.size, 2);
  assert.deepEqual(tl.activeWalls('X', 500), []);
  assert.deepEqual(tl.activeWalls('X', 1500).map((w) => [w.id, w.size, w.peak]), [[1, 200, 200]]);
  assert.deepEqual(tl.activeWalls('X', 5000).map((w) => [w.id, w.size, w.peak]), [[1, 300, 300], [2, 150, 150]]); // 2 never closed -> still standing
  assert.deepEqual(tl.activeWalls('X', 8000).filter((w) => w.id === 1).map((w) => [w.size, w.peak]), [[90, 300]]); // shrinking but peak remembered
  assert.deepEqual(tl.activeWalls('X', 9000).filter((w) => w.id === 1), []); // ended
  assert.deepEqual(tl.activeWalls('Y', 5000), []);
});
