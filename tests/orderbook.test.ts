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
  const s = new OrderBookSync('X', async () => snaps.shift()!, { onDesync: () => desyncs++, minResyncIntervalMs: 0 });
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

// ---- regression: the real-feed bug (constant "depth gap — resyncing") -------------------------------
/** Binance-style consecutive events: e_k covers ids 100k+1 .. 100k+100 and chains on pu = previous u. */
const ev = (k: number): DepthDiff => ({ U: 100 * k + 1, u: 100 * k + 100, pu: 100 * k, b: [['99', String(k + 1)]], a: [] });

test('sync: stays live when the snapshot is NEWER than the events received so far (first live event has pu < snapshot id)', async () => {
  let desyncs = 0, fetches = 0;
  // snapshot id 550 falls inside event 5 (501..600); events 0..3 arrive before it, event 4 after it
  const s = new OrderBookSync('X', async () => { fetches++; return snap(550); }, { onDesync: () => desyncs++, minResyncIntervalMs: 0 });
  for (let k = 0; k <= 3; k++) s.onDiff(ev(k)); // buffered while the snapshot downloads; all older than 550
  await tick();
  assert.equal(s.state, 'live'); // nothing to replay, but waiting for the first event that spans the snapshot
  s.onDiff(ev(4)); // u=500 < 550: stale, must be ignored — not treated as a gap
  assert.equal(s.state, 'live');
  s.onDiff(ev(5)); // 501..600 spans 550; its pu (500) is below the snapshot id — the old code called this a gap
  for (let k = 6; k < 100; k++) s.onDiff(ev(k));
  assert.equal(desyncs, 0, 'no spurious resyncs');
  assert.equal(fetches, 1, 'exactly one snapshot download');
  assert.equal(s.state, 'live');
  assert.equal(s.book.lastUpdateId, 100 * 99 + 100);
  assert.equal(s.book.bids.get(99), 100); // last event applied (event 99 sets qty 100)
});

test('sync: first live event that skips past the snapshot (U > id) means missed events -> resync', async () => {
  let desyncs = 0;
  const snaps = [snap(550), snap(1050)];
  const s = new OrderBookSync('X', async () => snaps.shift()!, { onDesync: () => desyncs++, minResyncIntervalMs: 0 });
  s.onDiff(ev(0));
  await tick();
  assert.equal(s.state, 'live');
  s.onDiff(ev(7)); // 701..800 but the snapshot was 550: events 5 and 6 were never seen
  assert.equal(s.state, 'syncing');
  await tick();
  assert.equal(s.resyncs, 2);
});

test('sync: snapshot downloads are throttled — repeated gaps cannot hammer the API', async () => {
  let t = 0, fetches = 0;
  const s = new OrderBookSync('X', async () => { fetches++; return snap(100); }, { now: () => t, minResyncIntervalMs: 5000 });
  s.onDiff(diff(99, 101, 98));
  await tick();
  assert.equal(fetches, 1);
  for (let i = 0; i < 20; i++) { t += 100; s.onDiff(diff(500 + i, 500 + i, 12345)); } // 20 broken events within 2 seconds
  await tick();
  assert.equal(fetches, 1, 'no new download inside the minimum interval');
  assert.equal(s.state, 'init');
  t = 5200;
  s.onDiff(diff(9000, 9001, 8999)); // interval passed: one new download is allowed
  await tick();
  assert.equal(fetches, 2);
});

test('sync: consecutive failures back off exponentially (capped), and success resets it', async () => {
  let t = 0, fetches = 0, fail = true;
  const s = new OrderBookSync('X', async () => { fetches++; if (fail) throw new Error('HTTP 429'); return snap(100); }, { now: () => t, retryDelayMs: 1000, minResyncIntervalMs: 0 });
  const poke = async () => { s.onDiff(diff(99, 101, 98)); await tick(); };
  await poke(); assert.equal(fetches, 1); // fails -> wait 1s
  t = 900; await poke(); assert.equal(fetches, 1);
  t = 1100; await poke(); assert.equal(fetches, 2); // fails again -> wait 2s
  t = 2900; await poke(); assert.equal(fetches, 2);
  t = 3200; await poke(); assert.equal(fetches, 3); // third failure -> wait 4s
  fail = false;
  t = 7300; await poke(); assert.equal(fetches, 4);
  assert.equal(s.state, 'live'); // success resets the backoff
  fail = true;
  s.reset();
  t = 7400; await poke(); assert.equal(fetches, 5); // fails -> back to the 1s base delay, not 8s
  t = 8500; await poke(); assert.equal(fetches, 6);
});
