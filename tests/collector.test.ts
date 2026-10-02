import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BinanceStream, parseAggTrade, streamUrl, type WsLike } from '../src/collector/binance.js';
import { fetchAggTradesRange, GapDetector } from '../src/collector/gaps.js';
import { LiveCollector } from '../src/collector/live.js';
import { Pipeline } from '../src/engine/pipeline.js';
import { MemoryNotifier } from '../src/alerts/notifier.js';
import { Store } from '../src/db/store.js';
import { testConfig } from './helpers.js';

class FakeWs extends EventEmitter implements WsLike {
  pings = 0; terminated = false;
  ping() { this.pings++; }
  terminate() { this.terminated = true; }
  close() { this.terminated = true; }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = (s: string, a: number, p = 100, q = 1, m = false, T = Date.now()) =>
  JSON.stringify({ stream: `${s.toLowerCase()}@aggTrade`, data: { e: 'aggTrade', s, a, p: String(p), q: String(q), T, m } });

test('url + parsing: m=true means aggressor SELL', () => {
  const url = streamUrl('wss://x/', ['BTCUSDT', 'ETHUSDT'], { enabled: true, speedMs: 500 });
  assert.equal(url, 'wss://x/stream?streams=btcusdt@aggTrade/btcusdt@depth@500ms/ethusdt@aggTrade/ethusdt@depth@500ms');
  const d = { e: 'aggTrade', s: 'BTCUSDT', a: 5, p: '100.5', q: '0.25', T: 123, m: true };
  assert.deepEqual(parseAggTrade(d), { symbol: 'BTCUSDT', aggId: 5, ts: 123, price: 100.5, size: 0.25, side: 'sell' });
  assert.equal(parseAggTrade({ ...d, m: false })!.side, 'buy');
  assert.equal(parseAggTrade({ e: 'depthUpdate' }), null);
  assert.equal(parseAggTrade({ ...d, p: 'nope' }), null);
});

test('gap detector', () => {
  const g = new GapDetector();
  assert.equal(g.check('A', 10), null);
  assert.equal(g.check('A', 11), null);
  assert.deepEqual(g.check('A', 15), { fromId: 12, toId: 14, missing: 3 });
  assert.equal(g.check('A', 14), null); // late/dup ignored
  assert.equal(g.check('B', 99), null); // symbols independent
  g.seed('C', 50);
  assert.deepEqual(g.check('C', 53), { fromId: 51, toId: 52, missing: 2 });
});

test('REST range backfill pages and stops at toId', async () => {
  const mk = (a: number) => ({ a, p: '1', q: '1', T: a, m: false });
  const pages: Record<number, any[]> = { 10: [mk(10), mk(11), mk(12)], 13: [mk(13), mk(14), mk(15)] };
  const urls: string[] = [];
  const out = await fetchAggTradesRange('https://r', 'X', 10, 14, async (u) => { urls.push(u); return pages[Number(/fromId=(\d+)/.exec(u)![1])] ?? []; });
  assert.deepEqual(out.map((t) => t.aggId), [10, 11, 12, 13, 14]);
  assert.equal(urls.length, 2);
});

test('stream reconnects with backoff after close, and on stale connection', async () => {
  const sockets: FakeWs[] = [];
  const msgs: string[] = [];
  const status: string[] = [];
  const s = new BinanceStream({
    url: 'wss://x', pingIntervalMs: 15, staleAfterMs: 60, reconnectMinDelayMs: 5, reconnectMaxDelayMs: 20, random: () => 1,
    wsFactory: () => { const w = new FakeWs(); sockets.push(w); return w; },
    onMessage: (m) => msgs.push(m.stream),
    onStatus: (st) => status.push(st),
  });
  s.start();
  sockets[0].emit('open');
  sockets[0].emit('message', frame('BTCUSDT', 1));
  assert.deepEqual(msgs, ['btcusdt@aggTrade']);
  await wait(40);
  assert.ok(sockets[0].pings >= 1, 'heartbeat pings sent');
  sockets[0].emit('close', 1006);
  await wait(30);
  assert.equal(sockets.length, 2, 'reconnected after close');
  sockets[1].emit('open'); // ...then goes silent -> watchdog must kill it
  await wait(150);
  assert.ok(status.includes('stale'));
  assert.ok(sockets[1].terminated);
  assert.ok(sockets.length >= 3, 'reconnected after stale');
  s.stop();
  assert.ok(s.reconnects >= 2);
});

test('live collector: persists trades, detects a gap, backfills before the live trade, flags silent backfill', async () => {
  const cfg = testConfig((c) => { c.assets.ETHUSDT.enabled = false; c.assets.SOLUSDT.enabled = false; });
  const store = new Store(':memory:');
  const notifier = new MemoryNotifier();
  const pipeline = new Pipeline(cfg, { store, notifier });
  const ws = new FakeWs();
  const seen: number[] = [];
  const orig = pipeline.onTrade.bind(pipeline);
  pipeline.onTrade = (t, silent) => { seen.push(t.aggId); orig(t, silent); };
  const col = new LiveCollector(cfg, store, pipeline, {
    wsFactory: () => ws, log: () => {},
    fetchJson: async () => [{ a: 3, p: '100', q: '1', T: 3, m: false }, { a: 4, p: '100', q: '1', T: 4, m: true }],
  });
  col.start();
  ws.emit('open');
  ws.emit('message', frame('BTCUSDT', 1));
  ws.emit('message', frame('BTCUSDT', 2));
  ws.emit('message', frame('BTCUSDT', 5)); // 3,4 missing
  ws.emit('message', frame('BTCUSDT', 6));
  await col.idle();
  await col.stop();
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
  assert.equal(col.gapsFound, 1);
  assert.equal(col.gapsRecovered, 1);
  const ids = [...store.iterTrades(['BTCUSDT'], 0, Date.now() + 1e6)].map((t) => t.aggId).sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6]);
  const gap = store.db.prepare('SELECT * FROM gaps').get() as any;
  assert.equal(gap.missing, 2);
  assert.equal(gap.recovered, 2);
});

test('live collector: failed backfill is recorded as unrecovered and processing continues', async () => {
  const cfg = testConfig((c) => { c.assets.ETHUSDT.enabled = false; c.assets.SOLUSDT.enabled = false; });
  const store = new Store(':memory:');
  const pipeline = new Pipeline(cfg, { store, notifier: new MemoryNotifier() });
  const ws = new FakeWs();
  const col = new LiveCollector(cfg, store, pipeline, { wsFactory: () => ws, log: () => {}, fetchJson: async () => { throw new Error('boom'); } });
  col.start();
  ws.emit('open');
  ws.emit('message', frame('BTCUSDT', 1));
  ws.emit('message', frame('BTCUSDT', 10));
  await col.idle();
  await col.stop();
  assert.equal((store.db.prepare('SELECT recovered FROM gaps').get() as any).recovered, 0);
  assert.equal(pipeline.engines.get('BTCUSDT')!.stats.trades, 2);
});
