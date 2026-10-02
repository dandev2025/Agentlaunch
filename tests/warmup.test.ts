import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../src/engine/pipeline.js';
import { MemoryNotifier } from '../src/alerts/notifier.js';
import { runReplay } from '../src/backtest/replay.js';
import { DEFAULT_SYNTH, generateSynthetic } from '../src/backtest/synthetic.js';
import { validateConfig } from '../src/config/load.js';
import { Store } from '../src/db/store.js';
import type { WallEvent } from '../src/core/types.js';
import { testConfig, trade } from './helpers.js';

const MIN = 60_000;
const btc = (warm?: number) => testConfig((c) => { c.assets.ETHUSDT.enabled = false; c.assets.SOLUSDT.enabled = false; if (warm !== undefined) c.volumeProfile.minWarmupMinutes = warm; });

/** One trade a second at 100 for `minutes`, so the profile has a clear POC at 100. */
function feed(p: Pipeline, from: number, minutes: number, silent = false) {
  for (let i = 0; i < minutes * 60; i++) p.onTrade(trade(from + i * 1000, 100, 1, i % 2 ? 'buy' : 'sell'), silent);
}
const big = (ts: number, side: 'buy' | 'sell' = 'buy') => trade(ts, 100.5, 10, side); // BTC threshold is 3 -> a big trade right at the POC

test('profile-based alerts are held back during warm-up and fire after it (default 30 min)', () => {
  const n = new MemoryNotifier();
  const store = new Store(':memory:');
  const p = new Pipeline(btc(), { store, notifier: n });
  const T0 = 1_000_000_000;
  feed(p, T0, 10);
  p.onTrade(big(T0 + 10 * MIN)); // 10 minutes in: the "POC" is only 10 minutes old
  assert.equal(n.messages.filter((m) => /big BUY at POC/.test(m)).length, 0);
  feed(p, T0 + 10 * MIN + 1000, 21);
  p.onTrade(big(T0 + 32 * MIN)); // past 30 minutes
  assert.equal(n.messages.filter((m) => /big BUY at POC/.test(m)).length, 1);
  // the big trade itself is still recorded while warming up (only the alert is held back)
  assert.equal((store.db.prepare("SELECT COUNT(*) c FROM big_trades").get() as any).c, 2);
});

test('minWarmupMinutes = 0 disables the gate', () => {
  const n = new MemoryNotifier();
  const p = new Pipeline(btc(0), { store: new Store(':memory:'), notifier: n });
  feed(p, 1_000_000_000, 1);
  p.onTrade(big(1_000_000_000 + 61_000));
  assert.equal(n.messages.filter((m) => /big BUY at POC/.test(m)).length, 1);
});

test('trading time seen during the silent warm-up replay counts, so a restart with stored trades is warm at once', () => {
  const n = new MemoryNotifier();
  const p = new Pipeline(btc(), { store: new Store(':memory:'), notifier: n });
  const T0 = 1_000_000_000;
  feed(p, T0, 40, true); // replayed silently from the database
  p.onTrade(big(T0 + 40 * MIN + 1000)); // first live trade after the restart
  assert.equal(n.messages.filter((m) => /big BUY at POC/.test(m)).length, 1);
});

test('wall alerts follow the same gate', () => {
  const ev = (ts: number): WallEvent => ({
    type: 'pulled', symbol: 'BTCUSDT', ts, wall: { id: 1, side: 'bid', price: 100, size: 5, peak: 400, firstSeen: ts - 120_000, executed: 10 },
    detail: { lifetimeMs: 120_000, spoofLike: false },
  });
  const n = new MemoryNotifier();
  const p = new Pipeline(btc(), { store: new Store(':memory:'), notifier: n });
  const T0 = 1_000_000_000;
  feed(p, T0, 5);
  p.onWallEvent(ev(T0 + 5 * MIN));
  assert.equal(n.messages.length, 0);
  feed(p, T0 + 5 * MIN + 1000, 30);
  p.onWallEvent(ev(T0 + 36 * MIN));
  assert.equal(n.messages.filter((m) => /wall PULLED/.test(m)).length, 1);
});

test('replay: no profile-based alert or signal before the warm-up has passed; with the gate off they appear earlier', () => {
  const store = new Store(':memory:');
  const start = Date.parse('2026-01-01T00:00:00Z');
  store.insertTrades([...generateSynthetic(DEFAULT_SYNTH, start, 3, 7)]);
  runReplay(store, testConfig(), { runId: 'gated' });
  runReplay(store, testConfig((c) => { c.volumeProfile.minWarmupMinutes = 0; }), { runId: 'open' });
  const first = (run: string, table: 'alerts' | 'signals', extra = '') =>
    (store.db.prepare(`SELECT MIN(ts) m FROM ${table} WHERE run_id = ? ${extra}`).get(run) as any).m as number | null;
  const lvl = "AND type = 'big_trade_at_level'";
  assert.ok(first('gated', 'alerts', lvl)! >= start + 30 * MIN, 'gated alerts start after warm-up');
  assert.ok(first('gated', 'signals')! >= start + 30 * MIN, 'gated signals start after warm-up');
  assert.ok(first('open', 'alerts', lvl)! < start + 30 * MIN, 'without the gate there are alerts inside the first 30 minutes');
});

test('config validation: warm-up must be >= 0', () => {
  assert.throws(() => validateConfig(testConfig((c) => { c.volumeProfile.minWarmupMinutes = -1; })), /minWarmupMinutes/);
  assert.doesNotThrow(() => validateConfig(testConfig((c) => { c.volumeProfile.minWarmupMinutes = 0; })));
});
