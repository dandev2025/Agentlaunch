import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cooldown } from '../src/alerts/cooldown.js';
import { TelegramNotifier, type FetchLike } from '../src/alerts/notifier.js';
import { bigTradeAtLevel } from '../src/alerts/rules.js';
import { toBigTrade } from '../src/indicators/bigTrades.js';
import { trade } from './helpers.js';
import type { ProfileSnapshot } from '../src/core/types.js';

const profile: ProfileSnapshot = { ts: 0, poc: 100, vah: 110, val: 90, hvns: [{ price: 95, volume: 50 }], totalVolume: 1000, binSize: 1 };

test('cooldown suppresses repeats per key and releases after the window', () => {
  const c = new Cooldown();
  assert.equal(c.tryFire('a', 0, 1000), true);
  assert.equal(c.tryFire('a', 999, 1000), false);
  assert.equal(c.tryFire('b', 999, 1000), true);
  assert.equal(c.tryFire('a', 1000, 1000), true);
});

test('big trade alert: only POC/HVN, only within distance, nearest wins', () => {
  const big = (p: number) => toBigTrade(trade(0, p, 10));
  assert.equal(bigTradeAtLevel(big(100.5), profile, ['POC', 'HVN'], 1)?.level.kind, 'POC');
  assert.equal(bigTradeAtLevel(big(95.2), profile, ['POC', 'HVN'], 1)?.level.kind, 'HVN');
  assert.equal(bigTradeAtLevel(big(97.5), profile, ['POC', 'HVN'], 1), null);
  assert.equal(bigTradeAtLevel(big(90), profile, ['POC', 'HVN'], 1), null); // VAL not configured
  assert.equal(bigTradeAtLevel(big(90), profile, ['VAL'], 1)?.level.kind, 'VAL');
});

test('telegram: sends HTML, retries on 429 with retry_after, drops on permanent error', async () => {
  const calls: any[] = [];
  const responses = [
    { ok: false, status: 429, json: async () => ({ parameters: { retry_after: 1 } }) },
    { ok: true, status: 200, json: async () => ({}) },
    { ok: false, status: 400, json: async () => ({ description: 'bad' }) },
    { ok: true, status: 200, json: async () => ({}) },
  ];
  const fetchFn: FetchLike = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return responses.shift()!; };
  const slept: number[] = [];
  const n = new TelegramNotifier('TOKEN', '42', fetchFn, 10, async (ms) => { slept.push(ms); });
  const origErr = console.error; console.error = () => {};
  try {
    n.send('one');
    n.send('two');
    n.send('three');
    await n.flush();
  } finally { console.error = origErr; }
  assert.equal(calls[0].url, 'https://api.telegram.org/botTOKEN/sendMessage');
  assert.equal(calls[0].body.chat_id, '42');
  assert.deepEqual(calls.map((c) => c.body.text), ['one', 'one', 'two', 'three']); // 'two' dropped after 400, still sent once
  assert.ok(slept.includes(1000));
});
