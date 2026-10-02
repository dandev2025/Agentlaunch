import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BinanceStream, parseAggTrade, streamUrl, type WsLike } from '../src/collector/binance.js';
import { fetchAggTradesRange, GapDetector } from '../src/collector/gaps.js';
import { LiveCollector } from '../src/collector/live.js';
import { Pipeline } from '../src/engine/pipeline.js';
import { MemoryNotifier } from '../src/alerts/notifier.js';
import { Store } from '../src/db/store.js';
import { HeatmapService } from '../src/collector/heatmap.js';
import { validateConfig } from '../src/config/load.js';
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

test('urls: trades on /market, order book on /public (the legacy combined /stream URL no longer delivers trades)', () => {
  assert.equal(streamUrl('wss://x/', 'market', ['BTCUSDT', 'ETHUSDT'], { speedMs: 500 }), 'wss://x/market/stream?streams=btcusdt@aggTrade/ethusdt@aggTrade');
  assert.equal(streamUrl('wss://x', 'public', ['BTCUSDT', 'ETHUSDT'], { speedMs: 500 }), 'wss://x/public/stream?streams=btcusdt@depth@500ms/ethusdt@depth@500ms');
});

test('parsing: m=true means aggressor SELL', () => {
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

// ---- two endpoints, health checks ------------------------------------------------------------
function twoSocketCollector(opts: { heat?: boolean; now?: () => number; log?: (m: string) => void } = {}) {
  const cfg = testConfig((c) => { c.assets.ETHUSDT.enabled = false; c.assets.SOLUSDT.enabled = false; });
  const store = new Store(':memory:');
  const pipeline = new Pipeline(cfg, { store, notifier: new MemoryNotifier() });
  const sockets: Record<string, FakeWs> = {};
  const urls: string[] = [];
  const heat = opts.heat ? new HeatmapService(cfg, store, { fetchJson: async () => ({ lastUpdateId: 100, bids: [['99', '5']], asks: [['101', '5']] }), log: () => {} }) : undefined;
  const col = new LiveCollector(cfg, store, pipeline, {
    log: opts.log ?? (() => {}), now: opts.now, heat,
    wsFactory: (url) => { urls.push(url); const w = new FakeWs(); sockets[url.includes('/market/') ? 'market' : 'public'] = w; return w; },
  });
  return { col, sockets, urls, heat, pipeline };
}

test('collector opens one connection without the heat map (trades only) and two with it', () => {
  const a = twoSocketCollector();
  a.col.start();
  assert.deepEqual(a.urls, ['wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade']);
  void a.col.stop();
  const b = twoSocketCollector({ heat: true });
  b.col.start();
  assert.deepEqual(b.urls.sort(), ['wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade', 'wss://fstream.binance.com/public/stream?streams=btcusdt@depth@500ms']);
  void b.col.stop();
});

test('health: an open trade connection that delivers nothing is flagged (the changed-endpoint failure), and clears once trades arrive', async () => {
  let t = 1_000_000;
  const { col, sockets } = twoSocketCollector({ now: () => t });
  col.start();
  sockets.market.emit('open');
  t += 30_000;
  assert.deepEqual(col.health(), []); // still within the grace period
  t += 40_000;
  assert.match(col.health().join('\n'), /connected to the trade stream for 70s but no trades have arrived/);
  sockets.market.emit('message', frame('BTCUSDT', 1));
  await col.idle();
  assert.equal(col.aggMessages, 1);
  assert.deepEqual(col.health(), []);
  await col.stop();
});

test('health: the order-book connection is checked separately; unreadable frames are counted and sampled in the log', async () => {
  let t = 0;
  const logs: string[] = [];
  const { col, sockets } = twoSocketCollector({ heat: true, now: () => t, log: (m) => logs.push(m) });
  col.start();
  sockets.market.emit('open'); sockets.public.emit('open');
  sockets.market.emit('message', frame('BTCUSDT', 1));
  sockets.market.emit('message', JSON.stringify({ stream: 'btcusdt@aggTrade', data: { e: 'somethingNew', s: 'BTCUSDT' } }));
  await col.idle();
  t = 90_000;
  const w = col.health().join('\n');
  assert.match(w, /order-book stream for 90s but no depth updates/);
  assert.match(w, /1 message\(s\) could not be read/);
  assert.ok(logs.some((l) => /unreadable message on btcusdt@aggTrade: .*somethingNew/.test(l)));
  assert.doesNotMatch(w, /no trades have arrived/);
  await col.stop();
});

test('only the order-book connection dropping resets the book; the trade connection dropping does not', async () => {
  const { col, sockets, heat } = twoSocketCollector({ heat: true });
  col.start();
  sockets.market.emit('open'); sockets.public.emit('open');
  sockets.public.emit('message', JSON.stringify({ stream: 'btcusdt@depth@500ms', data: { e: 'depthUpdate', s: 'BTCUSDT', U: 99, u: 101, pu: 98, b: [], a: [] } }));
  await wait(5);
  assert.equal(heat!.syncs.get('BTCUSDT')!.state, 'live');
  sockets.market.emit('close', 1006);
  assert.equal(heat!.syncs.get('BTCUSDT')!.state, 'live', 'trade connection loss must not discard the book');
  sockets.public.emit('close', 1006);
  assert.equal(heat!.syncs.get('BTCUSDT')!.state, 'init');
  await col.stop();
});

test('config rejects the legacy / path-style Binance WebSocket URLs', () => {
  for (const bad of ['wss://fstream.binance.com/stream', 'wss://fstream.binance.com/ws', 'wss://fstream.binance.com/market', 'wss://fstream.binance.com/public/stream?streams=x'])
    assert.throws(() => validateConfig(testConfig((c) => { c.collector.wsBaseUrl = bad; })), /wsBaseUrl must be the root/);
  assert.doesNotThrow(() => validateConfig(testConfig((c) => { c.collector.wsBaseUrl = 'wss://fstream.binance.com/'; })));
});
