import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HeatmapService } from '../src/collector/heatmap.js';
import { LiveCollector } from '../src/collector/live.js';
import type { WsLike } from '../src/collector/binance.js';
import { Pipeline } from '../src/engine/pipeline.js';
import { MemoryNotifier } from '../src/alerts/notifier.js';
import { evaluateDirection, type EvalContext } from '../src/signals/evaluate.js';
import { runReplay } from '../src/backtest/replay.js';
import { DEFAULT_SYNTH, generateSynthetic } from '../src/backtest/synthetic.js';
import { gatherStatus, formatStatus } from '../src/collector/status.js';
import { Store } from '../src/db/store.js';
import { validateConfig } from '../src/config/load.js';
import type { ProfileSnapshot, WallEvent, WallView } from '../src/core/types.js';
import { testConfig, trade } from './helpers.js';

const tick = () => new Promise((r) => setImmediate(r));
const btcOnly = (over: (c: ReturnType<typeof testConfig>) => void = () => {}) =>
  testConfig((c) => { c.assets.ETHUSDT.enabled = false; c.assets.SOLUSDT.enabled = false; c.heatmap.snapshot.intervalMs = 1000; over(c); });

/** BTC book: a 500 BTC bid at 64990, thin elsewhere (bin = $10). */
const BTC_SNAPSHOT = {
  lastUpdateId: 100,
  bids: [['64995', '10'], ['64990', '500'], ['64980', '12'], ['64970', '9'], ['64950', '11']],
  asks: [['65005', '10'], ['65010', '12'], ['65020', '9'], ['65030', '11'], ['65050', '10']],
};

test('service: tracks wall lifecycle into the DB, snapshots the book, expires on reconnect, closes orphans on start', async () => {
  const store = new Store(':memory:');
  const orphan = store.insertWall({ symbol: 'BTCUSDT', side: 'bid', price: 1, ts: 1, size: 1 });
  const cfg = btcOnly();
  const svc = new HeatmapService(cfg, store, { fetchJson: async () => BTC_SNAPSHOT, now: () => 0, log: () => {} });
  assert.equal((store.db.prepare('SELECT status FROM book_walls WHERE id = ?').get(orphan) as any).status, 'expired');

  const seen: string[] = [];
  svc.onWallEvent = (e) => seen.push(e.type);
  svc.onDepth('BTCUSDT', { U: 99, u: 101, pu: 98, b: [], a: [] });
  await tick();
  assert.equal(svc.syncs.get('BTCUSDT')!.state, 'live');

  svc.tick(1000);
  assert.deepEqual(seen, ['added']);
  assert.deepEqual(svc.activeWalls('BTCUSDT', 1000).map((w) => [w.side, w.price, w.size]), [['bid', 64990, 500]]);
  svc.onTrade(trade(1500, 64990, 30, 'sell'));
  // The wall is cancelled (qty 0) -> pulled, since only 30 of 500 traded into it
  svc.onDepth('BTCUSDT', { U: 102, u: 102, pu: 101, b: [['64990', '0']], a: [] });
  svc.tick(2000);
  assert.deepEqual(seen, ['added', 'pulled']);

  const walls = store.db.prepare("SELECT * FROM book_walls WHERE price = 64990").all() as any[];
  assert.equal(walls.length, 1);
  assert.deepEqual([walls[0].status, walls[0].peak_size, walls[0].executed, walls[0].first_seen, walls[0].last_seen], ['pulled', 500, 30, 1000, 2000]);
  const evs = store.db.prepare('SELECT type, size FROM book_wall_events WHERE wall_id = ? ORDER BY id').all(walls[0].id) as any[];
  assert.deepEqual(evs.map((e) => e.type), ['added', 'pulled']);
  assert.equal(svc.activeWalls('BTCUSDT', 2000).length, 0);

  const snaps = store.db.prepare('SELECT * FROM orderbook_snapshots').all() as any[];
  assert.ok(snaps.length >= 1);
  const bids = JSON.parse(snaps[0].bids) as [number, number][];
  assert.ok(bids.some(([p, q]) => p === 64990 && q === 500)); // the wall's bin
  assert.deepEqual(bids[0], [65000, 10]); // 64995 rounds into the 65000 bin; highest price first
  assert.ok(bids.every((b, i) => i === 0 || bids[i - 1][0] > b[0]));

  // a wall standing when the stream reconnects must be expired, not mislabelled pulled
  svc.onDepth('BTCUSDT', { U: 103, u: 103, pu: 102, b: [['64990', '400']], a: [] });
  svc.tick(3000);
  assert.equal(svc.activeWalls('BTCUSDT', 3000).length, 1);
  svc.onStreamReconnect();
  assert.equal(svc.activeWalls('BTCUSDT', 3000).length, 0);
  const last = store.db.prepare("SELECT status FROM book_walls ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(last.status, 'expired');
  svc.stop();
});

test('service: snapshot retention prunes old rows', () => {
  const store = new Store(':memory:');
  store.recordOrderbookSnapshot('BTCUSDT', 1000, [[1, 1]], [[2, 1]]);
  store.recordOrderbookSnapshot('BTCUSDT', 10 * 3_600_000, [[1, 1]], [[2, 1]]);
  assert.equal(store.pruneOrderbookSnapshots(5 * 3_600_000), 1);
});

class FakeWs extends EventEmitter implements WsLike {
  ping() {} terminate() {} close() {}
}

test('collector routes depth frames to the heat map and a disconnect desyncs the book', async () => {
  const cfg = btcOnly();
  const store = new Store(':memory:');
  const heat = new HeatmapService(cfg, store, { fetchJson: async () => BTC_SNAPSHOT, log: () => {} });
  const pipeline = new Pipeline(cfg, { store, notifier: new MemoryNotifier(), walls: heat });
  const ws = new FakeWs();
  const col = new LiveCollector(cfg, store, pipeline, { wsFactory: () => ws, log: () => {}, heat });
  col.start();
  ws.emit('open');
  const frame = (U: number, u: number, pu: number) =>
    JSON.stringify({ stream: 'btcusdt@depth@500ms', data: { e: 'depthUpdate', s: 'BTCUSDT', U, u, pu, b: [], a: [] } });
  ws.emit('message', frame(99, 101, 98));
  await tick();
  assert.equal(col.depthMessages, 1);
  assert.equal(heat.syncs.get('BTCUSDT')!.state, 'live');
  ws.emit('close', 1006);
  assert.equal(heat.syncs.get('BTCUSDT')!.state, 'init');
  await col.stop();
});

// ---- signal condition ---------------------------------------------------------
// These tests assert which conditions fire and exact point sums, so they pin the legacy flat scoring; confluence has its own tests.
const sc = testConfig((c) => { c.signals.confluence.enabled = false; }).signals;
const heatCfg = { requireAtLevel: true, minAgeMs: 30_000, holdFrac: 0.7 };
const profile: ProfileSnapshot = { ts: 0, poc: 110, val: 100, vah: 120, totalVolume: 1e4, binSize: 1, hvns: [{ price: 105, volume: 1 }] };
const T = 1_000_000;
const wall = (o: Partial<WallView> = {}): WallView => ({ id: 1, side: 'bid', price: 99.8, size: 500, peak: 500, firstSeen: T - 60_000, executed: 0, ...o });
const ctx = (o: Partial<EvalContext> = {}): EvalContext => ({
  symbol: 'BTCUSDT', ts: T, price: 100.3, atr: 2, near: 1, profile,
  flips: [{ direction: 'LONG', ts: T - 1000 }], divergences: [], bigTrades: [], htfZ: 0, walls: [wall()], ...o,
});
const keys = (r: any) => (r.ok ? r.candidate.conditions : r.conditions).map((c: any) => c.key);

test('bid wall holding under price at the level adds wall_holding (heatmap family)', () => {
  const r = evaluateDirection(sc, ctx(), 'LONG', undefined, heatCfg);
  assert.ok(r.ok);
  assert.deepEqual(keys(r).sort(), ['delta_flip', 'level:VAL', 'wall_holding']);
  assert.equal(r.candidate.score, 25 + 20 + 20);
  assert.ok(r.candidate.conditions.some((c) => c.family === 'heatmap'));
});

test('wall must be old enough, still holding, on the right side, close to price', () => {
  const no = (w: Partial<WallView>) => assert.ok(!keys(evaluateDirection(sc, ctx({ walls: [wall(w)] }), 'LONG', undefined, heatCfg)).includes('wall_holding'), JSON.stringify(w));
  no({ firstSeen: T - 10_000 }); // flash order
  no({ size: 300 }); // 60% of peak: being eaten/pulled
  no({ side: 'ask', price: 100.8 }); // wrong side for a long
  no({ price: 98.5 }); // too far below price (1.8 > near)
  no({ price: 101.2 }); // above price: price already traded through it
  assert.ok(keys(evaluateDirection(sc, ctx({ walls: [wall({ price: 100.5 })] }), 'LONG', undefined, heatCfg)).includes('wall_holding')); // half-bin slop
});

test('ask wall holding above price supports a SHORT; requireAtLevel gates location', () => {
  const sctx = ctx({
    price: 119.8, flips: [{ direction: 'SHORT', ts: T }], walls: [wall({ side: 'ask', price: 120.2 })],
  });
  assert.ok(keys(evaluateDirection(sc, sctx, 'SHORT', undefined, heatCfg)).includes('wall_holding'));
  // level (VAL) is 1.7 away from the wall: counts only when location is not required
  const custom: ProfileSnapshot = { ...profile, val: 101.7 };
  const c2 = ctx({ price: 100.9, profile: custom, walls: [wall({ price: 99.95 })] });
  assert.ok(!keys(evaluateDirection(sc, c2, 'LONG', undefined, heatCfg)).includes('wall_holding'));
  assert.ok(keys(evaluateDirection(sc, c2, 'LONG', undefined, { ...heatCfg, requireAtLevel: false })).includes('wall_holding'));
});

test('wall alone cannot make a signal', () => {
  const r = evaluateDirection(sc, ctx({ flips: [] }), 'LONG', undefined, heatCfg);
  assert.ok(!r.ok && r.reason === 'min_conditions'); // level + wall = 2 conditions
});

// ---- alerts ---------------------------------------------------------------------
test('wall pulled/eaten at a profile level alerts once per cooldown; other events and far walls do not', () => {
  const cfg = btcOnly();
  const store = new Store(':memory:');
  const notifier = new MemoryNotifier();
  const pipeline = new Pipeline(cfg, { store, notifier });
  for (let i = 0; i < 50; i++) pipeline.onTrade(trade(1000 + i, 65000, 1, i % 2 ? 'buy' : 'sell')); // POC = 65000
  const ev = (type: WallEvent['type'], price: number, ts: number): WallEvent => ({
    type, symbol: 'BTCUSDT', ts, wall: { id: 1, side: 'bid', price, size: 5, peak: 400, firstSeen: ts - 120_000, executed: 10 },
    detail: { lifetimeMs: 120_000, spoofLike: false },
  });
  pipeline.onWallEvent(ev('added', 65000, 2000)); // not a configured event
  pipeline.onWallEvent(ev('pulled', 64000, 2000)); // not near any level
  assert.equal(notifier.messages.length, 0);
  pipeline.onWallEvent(ev('pulled', 65010, 3000));
  assert.equal(notifier.messages.length, 1);
  assert.match(notifier.messages[0], /bid wall PULLED at 65010\.0/);
  assert.match(notifier.messages[0], /near POC/);
  pipeline.onWallEvent(ev('pulled', 65010, 4000)); // inside cooldown
  assert.equal(notifier.messages.length, 1);
  pipeline.onWallEvent(ev('eaten', 65010, 5000)); // different event type -> own cooldown key
  assert.equal(notifier.messages.length, 2);
  const rows = store.db.prepare("SELECT type, inputs FROM alerts WHERE type LIKE 'wall_%'").all() as any[];
  assert.deepEqual(rows.map((r) => r.type), ['wall_pulled', 'wall_eaten']);
  assert.ok(JSON.parse(rows[0].inputs).profile.poc === 65000);
});

// ---- replay ---------------------------------------------------------------------
test('replay rebuilds wall state from stored walls so wall_holding can be backtested', () => {
  const cfg = testConfig();
  const store = new Store(':memory:');
  const start = Date.parse('2026-01-01T00:00:00Z');
  store.insertTrades([...generateSynthetic(DEFAULT_SYNTH, start, 8, 7)]);
  // dense grid of long-lived walls on both sides across each symbol's price range
  for (const sym of Object.keys(cfg.assets)) {
    const r = store.db.prepare('SELECT MIN(price) lo, MAX(price) hi FROM trades WHERE symbol = ?').get(sym) as any;
    const bin = cfg.assets[sym].binSize;
    for (let p = Math.floor(r.lo / bin) * bin - 5 * bin; p <= r.hi + 5 * bin; p += bin) {
      for (const side of ['bid', 'ask'] as const) {
        const id = store.insertWall({ symbol: sym, side, price: p, ts: start - 3_600_000, size: 1000 });
        store.updateWall(id, { ts: start + 9 * 3_600_000, size: 1000, peak: 1000, executed: 0, status: 'expired' });
      }
    }
  }
  const withWalls = runReplay(store, cfg, { runId: 'w' });
  assert.ok(withWalls.walls > 0);
  const n = (run: string) => (store.db.prepare(
    `SELECT COUNT(*) c FROM signal_conditions sc JOIN signals s ON s.id = sc.signal_id WHERE s.run_id = ? AND sc.key = 'wall_holding'`,
  ).get(run) as any).c;
  assert.ok(n('w') > 0, 'wall_holding should appear in replayed signals');

  const noHeat = runReplay(store, testConfig((c) => { c.heatmap.enabled = false; }), { runId: 'n' });
  assert.equal(noHeat.walls, 0);
  assert.equal(n('n'), 0);
});

// ---- status / config ---------------------------------------------------------------
test('status shows standing walls', () => {
  const cfg = btcOnly();
  const store = new Store(':memory:');
  const pipeline = new Pipeline(cfg, { store, notifier: new MemoryNotifier() });
  const col = new LiveCollector(cfg, store, pipeline, { log: () => {} });
  const walls = { activeWalls: () => [wall(), wall({ id: 2 })] };
  pipeline.onTrade(trade(1000, 65000, 1));
  assert.match(formatStatus(gatherStatus(col, pipeline, store, 0, 5000, walls)), /2 walls/);
  assert.doesNotMatch(formatStatus(gatherStatus(col, pipeline, store, 0, 5000)), /walls/);
});

test('config validation covers heat-map settings', () => {
  assert.throws(() => validateConfig(testConfig((c) => { c.collector.depth.enabled = false; })), /requires collector\.depth/);
  assert.throws(() => validateConfig(testConfig((c) => { c.assets.BTCUSDT.wallMinQty = 0; })), /wallMinQty/);
  assert.throws(() => validateConfig(testConfig((c) => { c.heatmap.rangePct = 0.5; })), /rangePct/);
  assert.throws(() => validateConfig(testConfig((c) => { c.heatmap.wall.holdFrac = 0.1; })), /holdFrac/);
  assert.doesNotThrow(() => validateConfig(testConfig((c) => { c.heatmap.enabled = false; c.collector.depth.enabled = false; })));
});
