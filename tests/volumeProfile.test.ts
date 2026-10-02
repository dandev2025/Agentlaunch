import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VolumeProfile } from '../src/indicators/volumeProfile.js';

const mk = (windowMs = 3_600_000) =>
  new VolumeProfile({ binSize: 1, windowMs, valueAreaPct: 0.7, hvnFactor: 1.5, hvnMinSepBins: 2, hvnSmoothBins: 0 });

test('POC, value area and HVNs on a bimodal profile', () => {
  const p = mk();
  // volume by price: 100:5 101:10 102:40 103:10 104:5 105:5 106:10 107:30 108:10 109:5
  const vols: Record<number, number> = { 100: 5, 101: 10, 102: 40, 103: 10, 104: 5, 105: 5, 106: 10, 107: 30, 108: 10, 109: 5 };
  for (const [price, v] of Object.entries(vols)) p.add(1000, Number(price), v);
  const s = p.snapshot(1000)!;
  assert.equal(s.poc, 102);
  assert.equal(s.totalVolume, 130);
  assert.ok(s.val <= 102 && s.vah >= 102);
  // value area holds >= 70% of volume
  let inVa = 0;
  for (const [price, v] of Object.entries(vols)) if (Number(price) >= s.val && Number(price) <= s.vah) inVa += v;
  assert.ok(inVa / 130 >= 0.7, `VA volume share ${inVa / 130}`);
  assert.deepEqual(s.hvns.map((h) => h.price), [107]); // POC itself excluded
});

test('rolling window evicts old volume and moves the POC', () => {
  const p = mk(10 * 60_000);
  p.add(0, 100, 100);
  p.add(5 * 60_000, 110, 10);
  assert.equal(p.snapshot(5 * 60_000)!.poc, 100);
  const s = p.snapshot(20 * 60_000); // everything expired by now
  assert.equal(s, null);
  p.add(20 * 60_000, 120, 1);
  assert.equal(p.snapshot(20 * 60_000)!.poc, 120);
  assert.equal(p.totalVolume, 1);
});

test('empty profile returns null', () => {
  assert.equal(mk().snapshot(0), null);
});
