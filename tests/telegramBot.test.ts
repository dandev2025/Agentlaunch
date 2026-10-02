import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramCommandListener } from '../src/alerts/telegramBot.js';
import { formatStatus, gatherStatus } from '../src/collector/status.js';
import type { FetchLike } from '../src/alerts/notifier.js';
import { Pipeline } from '../src/engine/pipeline.js';
import { MemoryNotifier } from '../src/alerts/notifier.js';
import { LiveCollector } from '../src/collector/live.js';
import { Store } from '../src/db/store.js';
import { testConfig, trade } from './helpers.js';

const upd = (id: number, chat: number, text: string) => ({ update_id: id, message: { chat: { id: chat }, text } });

function mk(updates: any[][]) {
  const bodies: any[] = [];
  const fetchFn: FetchLike = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ result: updates.shift() ?? [] }) };
  };
  const replies: string[] = [];
  const calls: string[] = [];
  const l = new TelegramCommandListener('T', '42', {
    status: () => { calls.push('status'); return 'STATUS'; },
    boom: () => { throw new Error('nope'); },
  }, (t) => replies.push(t), fetchFn, async () => {});
  return { l, bodies, replies, calls };
}

test('answers /status from the configured chat only, advances offset', async () => {
  const { l, bodies, replies, calls } = mk([
    [upd(10, 42, '/status'), upd(11, 999, '/status'), upd(12, 42, 'hello'), upd(13, 42, '/unknown')],
    [upd(14, 42, '/STATUS@MyBot please')],
  ]);
  await l.pollOnce();
  assert.deepEqual(replies, ['STATUS']);
  await l.pollOnce();
  assert.equal(bodies[1].offset, 14); // acknowledged everything up to 13
  assert.deepEqual(replies, ['STATUS', 'STATUS']);
  assert.equal(calls.length, 2);
});

test('handler errors are reported, not thrown', async () => {
  const { l, replies } = mk([[upd(1, 42, '/boom')]]);
  await l.pollOnce();
  assert.match(replies[0], /\/boom failed: nope/);
});

test('poll surfaces HTTP errors (e.g. 409 conflict)', async () => {
  const l = new TelegramCommandListener('T', '42', {}, () => {}, async () => ({ ok: false, status: 409, json: async () => ({ description: 'Conflict' }) }), async () => {});
  await assert.rejects(l.pollOnce(), /409.*Conflict/);
});

test('status reflects pipeline, collector and DB state', () => {
  const cfg = testConfig((c) => { c.assets.ETHUSDT.enabled = false; c.assets.SOLUSDT.enabled = false; });
  const store = new Store(':memory:');
  const pipeline = new Pipeline(cfg, { store, notifier: new MemoryNotifier() });
  const col = new LiveCollector(cfg, store, pipeline, { log: () => {} });
  const now = 10_000_000;
  pipeline.onTrade(trade(now - 2000, 65000.5, 1));
  store.recordAlert(now - 1000, 'BTCUSDT', 'delta_divergence', 'm', {});
  store.recordAlert(now - 90_000_000, 'BTCUSDT', 'delta_divergence', 'old', {});
  const d = gatherStatus(col, pipeline, store, now - 3 * 3_600_000, now);
  assert.equal(d.last24h.alerts, 1);
  assert.equal(d.symbols[0].trades, 1);
  const text = formatStatus(d);
  assert.match(text, /Uptime 3h 0m/);
  assert.match(text, /disconnected/);
  assert.match(text, /BTCUSDT.*65000\.5.*1 trades.*last 2s ago/);
  assert.match(text, /Last signal: none yet/);
});
