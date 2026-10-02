import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalOrderBook, OrderBookSync, type DepthDiff, type DepthSnapshot } from '../src/collector/orderbook.js';

const tick = () => new Promise((r) => setImmediate(r));
const diff = (U: number, u: number, pu: number, b: [string, string][] = [], a: [string, string][] = []): DepthDiff => ({ U, u, pu, b, a });
const snap = (lastUpdateId: number): DepthSnapshot => ({ lastUpdateId, bids: [['99', '5'], ['98', '7']], asks: [['101', '5'], ['102', '3']] });

test('book: apply diffs (qty 0 removes), best, aggregate to bins within range', () => {
  const b = new LocalOrderBook();
  b.load({ lastUpdateId: 1, bids: [['99.4', '1'], ['99.1', '2'], ['90', '9']], asks: [['100.6', '4'], ['100.9', '1'], ['110', '9']] });
  b.apply(diff(2, 2, 1, [['99.4', '0']], [['100.6', '6']]));
  assert.deepEqual(b.best(), { bid: 99.1, ask: 100.6 });
  const agg = b.aggregate(1, 0.02)!; // ±2% around mid 99.85
  assert.equal(agg.bids.get(99), 2); // 99.1 -> bin 99
  assert.equal(agg.asks.get(101), 7); // 100.6 + 100.9 -> bin 101
  assert.ok(!agg.bids.has(90) && !agg.asks.has(110)); // outside range
  assert.equal(agg.mid, (99.1 + 100.6) / 2);
  assert.equal(new LocalOrderBook().aggregate(1, 0.01), null);
});

test('sync: buffers, drops stale events, requires U<=lastUpdateId<=u, then follows pu chain', async () => {
  const s = new OrderBookSync('X', async () => snap(100), { retryDelayMs: 0 });
  s.onDiff(diff(90, 99, 80)); // stale (u < 100) -> dropped
  s.onDiff(diff(99, 102, 99, [['99', '9']])); // covers snapshot
  s.onDiff(diff(103, 105, 102, [], [['101', '0']]));
  assert.equal(s.state, 'syncing');
  await tick();
  assert.equal(s.state, 'live');
  assert.equal(s.book.bids.get(99), 9);
  assert.ok(!s.book.asks.has(101));
  s.onDiff(diff(106, 106, 105, [['97', '1']]));
  assert.equal(s.book.bids.get(97), 1);
});

test('sync: a broken chain in the buffer fails the sync, then retries after the delay', async () => {
  let t = 0, fetches = 0;
  const snaps = [snap(100), snap(106)]; // a later snapshot is newer, as on the real exchange
  const s = new OrderBookSync('X', async () => { fetches++; return snaps.shift()!; }, { now: () => t, retryDelayMs: 5000 });
  s.onDiff(diff(99, 102, 98));
  s.onDiff(diff(104, 105, 103)); // pu 103 != 102 -> broken
  await tick();
  assert.equal(s.state, 'init');
  assert.equal(fetches, 1);
  s.onDiff(diff(106, 107, 105)); // within the retry delay: no new fetch
  assert.equal(fetches, 1);
  t = 6000;
  s.onDiff(diff(108, 108, 107)); // triggers the retry; buffered 106..107 covers snapshot 106, then 108 chains on
  await tick();
  assert.equal(fetches, 2);
  assert.equal(s.state, 'live');
});

test('sync: first event not covering the snapshot fails the sync', async () => {
  const s = new OrderBookSync('X', async () => snap(100), { retryDelayMs: 10_000, now: () => 0 });
  s.onDiff(diff(150, 160, 149)); // starts after the snapshot -> events were missed
  await tick();
  assert.equal(s.state, 'init');
});

test('sync: a gap while live triggers desync callback and a resync', async () => {
  const snaps = [snap(100), snap(211)];
  let desyncs = 0;
  const s = new OrderBookSync('X', async () => snaps.shift()!, { onDesync: () => desyncs++ });
  s.onDiff(diff(99, 101, 98));
  await tick();
  assert.equal(s.state, 'live');
  s.onDiff(diff(210, 212, 150)); // pu != last u (101)
  assert.equal(desyncs, 1);
  assert.equal(s.state, 'syncing');
  await tick();
  assert.equal(s.state, 'live');
  assert.equal(s.resyncs, 2);
});

test('sync: reset() (stream reconnect) drops to init and notifies', async () => {
  let desyncs = 0;
  const s = new OrderBookSync('X', async () => snap(100), { onDesync: () => desyncs++ });
  s.onDiff(diff(99, 101, 98));
  await tick();
  s.reset();
  assert.equal(s.state, 'init');
  assert.equal(desyncs, 1);
});
