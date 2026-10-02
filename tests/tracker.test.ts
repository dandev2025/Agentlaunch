import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalTracker } from '../src/signals/tracker.js';
import type { SignalUpdate } from '../src/db/store.js';

const setup = (dir: 'LONG' | 'SHORT' = 'LONG') => {
  const updates: SignalUpdate[] = [];
  const t = new SignalTracker({ maxHoldMs: 10_000, t1Fraction: 0.5 }, (_id, u) => updates.push(u));
  const s = dir === 'LONG'
    ? { id: 1, symbol: 'X', direction: 'LONG' as const, ts: 0, entry: 100, stop: 98, t1: 104, t2: 108 }
    : { id: 1, symbol: 'X', direction: 'SHORT' as const, ts: 0, entry: 100, stop: 102, t1: 96, t2: 92 };
  t.add(s);
  return { t, updates };
};

test('stop before T1 = -1R with MFE/MAE recorded', () => {
  const { t, updates } = setup();
  t.onPrice('X', 1, 101);
  t.onPrice('X', 2, 97.9);
  const u = updates.at(-1)!;
  assert.equal(u.outcome, 'STOP');
  assert.equal(u.realizedR, -1);
  assert.equal(u.maxFavorable, 1);
  assert.ok(Math.abs(u.maxAdverse - 2.1) < 1e-9);
  assert.equal(t.openCount, 0);
});

test('T1 then T2: half at 2R, half at 4R = 3R', () => {
  const { t, updates } = setup();
  t.onPrice('X', 1, 104);
  assert.equal(updates.at(-1)!.closed, false);
  assert.equal(updates.at(-1)!.t1Ts, 1);
  t.onPrice('X', 2, 108.5);
  const u = updates.at(-1)!;
  assert.equal(u.outcome, 'T2');
  assert.equal(u.realizedR, 3);
  assert.equal(u.maxFavorableR, 4.25);
});

test('T1 then back to stop: 0.5*2R - 0.5*1R = 0.5R, outcome T1', () => {
  const { t, updates } = setup();
  t.onPrice('X', 1, 105);
  t.onPrice('X', 2, 97);
  assert.equal(updates.at(-1)!.outcome, 'T1');
  assert.equal(updates.at(-1)!.realizedR, 0.5);
});

test('SHORT mirrors', () => {
  const { t, updates } = setup('SHORT');
  t.onPrice('X', 1, 96);
  t.onPrice('X', 2, 91);
  assert.equal(updates.at(-1)!.outcome, 'T2');
  assert.equal(updates.at(-1)!.realizedR, 0.5 * 2 + 0.5 * 4);
});

test('expiry marks to market; other symbols ignored', () => {
  const { t, updates } = setup();
  t.onPrice('Y', 1, 50);
  assert.equal(updates.length, 0);
  t.onPrice('X', 5_000, 101);
  t.onPrice('X', 10_001, 101);
  const u = updates.at(-1)!;
  assert.equal(u.outcome, 'EXPIRED');
  assert.equal(u.realizedR, 0.5);
});

test('stop and target are resolved in trade order (stop first wins)', () => {
  const { t, updates } = setup();
  t.onPrice('X', 1, 97);
  t.onPrice('X', 2, 109);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].outcome, 'STOP');
});
