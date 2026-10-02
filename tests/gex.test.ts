import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bsGamma, computeGex, parseInstrument, type BookSummaryRow, type GexOptions } from '../src/indicators/gex.js';
import { fetchBookSummary, GexService } from '../src/collector/gex.js';
import { GexTimeline } from '../src/backtest/gexTimeline.js';
import { runReplay } from '../src/backtest/replay.js';
import { DEFAULT_SYNTH, generateSynthetic } from '../src/backtest/synthetic.js';
import { evaluateDirection, type EvalContext } from '../src/signals/evaluate.js';
import { Pipeline } from '../src/engine/pipeline.js';
import { LiveCollector } from '../src/collector/live.js';
import { MemoryNotifier } from '../src/alerts/notifier.js';
import { formatStatus, gatherStatus } from '../src/collector/status.js';
import { validateConfig } from '../src/config/load.js';
import { Store } from '../src/db/store.js';
import type { GexSnapshot, GexView, ProfileSnapshot } from '../src/core/types.js';
import { testConfig, trade } from './helpers.js';

const opts: GexOptions = { minHoursToExpiry: 2, maxDaysToExpiry: 60, gridPct: 0.3, gridStepPct: 0.005 };
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const row = (name: string, oi: number, iv = 60, fwd = 100): BookSummaryRow => ({
  instrument_name: name, open_interest: oi, mark_iv: iv, underlying_price: fwd, estimated_delivery_price: 100,
});

test('instrument names parse to expiry 08:00 UTC, strike and type; junk is rejected', () => {
  assert.deepEqual(parseInstrument('BTC-27JUN25-100000-C'), { currency: 'BTC', expiryTs: Date.UTC(2025, 5, 27, 8), strike: 100000, type: 'C' });
  assert.equal(parseInstrument('ETH-3OCT25-2500-P')!.expiryTs, Date.UTC(2025, 9, 3, 8));
  assert.equal(parseInstrument('ETH-27JUN25-0d5-P')!.strike, 0.5);
  assert.equal(parseInstrument('BTC-PERPETUAL'), null);
  assert.equal(parseInstrument('BTC-27XYZ25-100-C'), null);
});

test('Black-Scholes gamma: known ATM value, peaks near the money, zero for bad inputs', () => {
  // F=K=100, sigma=0.5, T=1 -> d1=0.25, gamma = phi(0.25)/(100*0.5) = 0.0077334
  assert.ok(Math.abs(bsGamma(100, 100, 1, 0.5) - 0.0077334) < 1e-6);
  assert.ok(bsGamma(100, 100, 1, 0.5) > bsGamma(100, 150, 1, 0.5));
  assert.ok(bsGamma(100, 100, 1, 0.5) > bsGamma(100, 70, 1, 0.5));
  assert.equal(bsGamma(100, 100, 0, 0.5), 0);
  assert.equal(bsGamma(100, 100, 1, 0), 0);
});

test('puts dominate near spot, calls above: net GEX negative and the flip sits ABOVE spot', () => {
  const s = computeGex('BTC', [row('BTC-30JAN26-100-P', 1000), row('BTC-30JAN26-130-C', 1000)], NOW, opts)!;
  assert.ok(s.totalGex < 0);
  assert.ok(s.flipLevel! > s.spot && s.flipLevel! < 135, `flip ${s.flipLevel}`);
  assert.equal(s.spot, 100);
  assert.equal(s.instruments, 2);
});

test('calls dominate near spot, puts below: net GEX positive and the flip sits BELOW spot', () => {
  const s = computeGex('BTC', [row('BTC-30JAN26-100-C', 1000), row('BTC-30JAN26-70-P', 1000)], NOW, opts)!;
  assert.ok(s.totalGex > 0);
  assert.ok(s.flipLevel! < s.spot && s.flipLevel! > 65, `flip ${s.flipLevel}`);
});

test('no sign change within the search range -> flip is null', () => {
  const s = computeGex('BTC', [row('BTC-30JAN26-100-C', 500), row('BTC-30JAN26-120-C', 500)], NOW, opts)!;
  assert.ok(s.totalGex > 0);
  assert.equal(s.flipLevel, null);
});

test('per-strike breakdown: calls +, puts -, net and OI summed', () => {
  const s = computeGex('BTC', [row('BTC-30JAN26-100-C', 300), row('BTC-30JAN26-100-P', 100), row('BTC-30JAN26-120-C', 50)], NOW, opts)!;
  assert.deepEqual(s.strikes.map((k) => k.strike), [100, 120]);
  const k = s.strikes[0];
  assert.ok(k.callGex > 0 && k.putGex < 0);
  assert.ok(Math.abs(k.gex - (k.callGex + k.putGex)) < 1e-9);
  assert.equal(k.oi, 400);
  assert.ok(Math.abs(s.totalGex - s.strikes.reduce((a, x) => a + x.gex, 0)) < 1e-6);
});

test('filters: expired / too-near / too-far expiries, zero OI, missing IV, other currencies', () => {
  const rows: BookSummaryRow[] = [
    row('BTC-30JAN26-100-C', 100), // kept
    row('BTC-30DEC25-100-C', 100), // already expired
    row('BTC-30JUN26-100-C', 100), // beyond maxDaysToExpiry
    row('BTC-30JAN26-100-P', 0), // no OI
    { ...row('BTC-30JAN26-110-C', 100), mark_iv: null }, // no IV
    row('ETH-30JAN26-100-C', 100), // wrong currency
    row('BTC-PERPETUAL', 100),
  ];
  assert.equal(computeGex('BTC', rows, NOW, opts)!.instruments, 1);
  assert.equal(computeGex('BTC', rows.slice(1, 2), NOW, opts), null);
  // inside the last 2 hours before expiry the (explosive) 0DTE gamma is ignored
  assert.equal(computeGex('BTC', [row('BTC-30JAN26-100-C', 100)], Date.UTC(2026, 0, 30, 7, 30), opts), null);
});

// ---- service ------------------------------------------------------------------
const feed = (rowsByCur: Record<string, BookSummaryRow[]>) => async (url: string) => {
  const cur = /currency=(\w+)/.exec(url)![1];
  return { result: rowsByCur[cur] ?? [] };
};
const BTC_ROWS = [row('BTC-30JAN26-100-P', 1000), row('BTC-30JAN26-130-C', 1000)];
const ETH_ROWS = [row('ETH-30JAN26-100-C', 1000), row('ETH-30JAN26-70-P', 1000)];

test('fetchBookSummary surfaces Deribit errors and malformed responses', async () => {
  await assert.rejects(fetchBookSummary('https://d', 'BTC', async () => ({ error: { code: 10001, message: 'nope' } })), /10001.*nope/);
  await assert.rejects(fetchBookSummary('https://d', 'BTC', async () => ({ foo: 1 })), /unexpected/);
  let url = '';
  await fetchBookSummary('https://d/', 'ETH', async (u) => { url = u; return { result: [] }; });
  assert.equal(url, 'https://d/api/v2/public/get_book_summary_by_currency?currency=ETH&kind=option');
});

test('service: polls BTC and ETH only, persists, serves views; SOL has none; failures keep the last snapshot', async () => {
  const cfg = testConfig();
  const store = new Store(':memory:');
  let fail = false;
  const f = feed({ BTC: BTC_ROWS, ETH: ETH_ROWS });
  const seenUrls: string[] = [];
  const svc = new GexService(cfg, store, {
    now: () => NOW, log: () => {},
    fetchJson: async (u) => { seenUrls.push(u); if (fail) throw new Error('down'); return f(u); },
  });
  await svc.poll();
  assert.deepEqual(seenUrls.map((u) => /currency=(\w+)/.exec(u)![1]).sort(), ['BTC', 'ETH']); // never SOL
  const btc = svc.gexFor('BTCUSDT', NOW)!;
  assert.equal(btc.underlying, 'BTC');
  assert.ok(btc.flipLevel! > btc.spot);
  assert.ok(svc.gexFor('ETHUSDT', NOW)!.flipLevel! < 100);
  assert.equal(svc.gexFor('SOLUSDT', NOW), null);
  const rows = store.loadGexSnapshots(['BTC', 'ETH'], 0, NOW + 1, true);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.instruments === 2 && r.strikes.length === 2));

  fail = true;
  await svc.poll();
  assert.equal(svc.failures, 2);
  assert.equal(svc.gexFor('BTCUSDT', NOW + 1)!.ts, NOW); // old snapshot retained (the engine ages it out)
  assert.equal(store.loadGexSnapshots(['BTC'], 0, NOW + 10_000).length, 1); // nothing new stored
});

test('service: an empty options response counts as a failure, persist=false stores nothing', async () => {
  const cfg = testConfig((c) => { c.gex.persist = false; });
  const store = new Store(':memory:');
  const logs: string[] = [];
  const svc = new GexService(cfg, store, { now: () => NOW, log: (m) => logs.push(m), fetchJson: feed({ BTC: BTC_ROWS }) });
  await svc.poll();
  assert.ok(logs.some((l) => /ETH refresh failed.*no usable ETH options/.test(l)));
  assert.equal(svc.gexFor('ETHUSDT', NOW), null);
  assert.equal(store.loadGexSnapshots(['BTC'], 0, NOW + 1).length, 0);
});

// ---- replay timeline -------------------------------------------------------------
const snap = (underlying: string, ts: number, flip: number | null): GexSnapshot => ({ underlying, ts, spot: 100, flipLevel: flip, totalGex: 1e6, strikes: [], instruments: 10 });

test('timeline: latest snapshot at or before t; none before the first; no mapping => null', () => {
  const tl = new GexTimeline({ BTCUSDT: 'BTC', ETHUSDT: 'ETH' }, [snap('BTC', 300, 3), snap('BTC', 100, 1), snap('BTC', 200, 2), snap('ETH', 150, 9)]);
  assert.equal(tl.size, 4);
  assert.equal(tl.gexFor('BTCUSDT', 50), null);
  assert.equal(tl.gexFor('BTCUSDT', 100)!.flipLevel, 1);
  assert.equal(tl.gexFor('BTCUSDT', 250)!.flipLevel, 2);
  assert.equal(tl.gexFor('BTCUSDT', 9999)!.flipLevel, 3);
  assert.equal(tl.gexFor('ETHUSDT', 160)!.flipLevel, 9);
  assert.equal(tl.gexFor('SOLUSDT', 9999), null);
});

test('timeline.fromStore also loads the snapshot that preceded the window', () => {
  const store = new Store(':memory:');
  for (const s of [snap('BTC', 100, 1), snap('BTC', 200, 2), snap('BTC', 400, 4)]) store.insertGexSnapshot(s);
  const tl = GexTimeline.fromStore(store, testConfig(), 250, 500);
  assert.equal(tl.gexFor('BTCUSDT', 260)!.flipLevel, 2); // taken before the window, still the current one
  assert.equal(tl.gexFor('BTCUSDT', 450)!.flipLevel, 4);
});

// ---- signal condition ----------------------------------------------------------------
const sc = testConfig().signals;
const gcfg = { maxAgeMs: 1_800_000, minDistancePct: 0.001 };
const profile: ProfileSnapshot = { ts: 0, poc: 110, val: 100, vah: 120, totalVolume: 1e4, binSize: 1, hvns: [{ price: 105, volume: 1 }] };
const T = 1_000_000_000;
const gex = (o: Partial<GexView> = {}): GexView => ({ underlying: 'BTC', ts: T - 60_000, spot: 100, flipLevel: 99, totalGex: 5e6, ...o });
const ctx = (o: Partial<EvalContext> = {}): EvalContext => ({
  symbol: 'BTCUSDT', ts: T, price: 100.3, atr: 2, near: 1, profile,
  flips: [{ direction: 'LONG', ts: T - 1000 }], divergences: [], bigTrades: [], htfZ: 0, gex: gex(), ...o,
});
const keys = (r: any) => (r.ok ? r.candidate.conditions : r.conditions).map((c: any) => c.key);

test('LONG above the flip level earns gex_flip (gex family) and can complete a signal', () => {
  const r = evaluateDirection(sc, ctx(), 'LONG', undefined, undefined, gcfg);
  assert.ok(r.ok);
  assert.deepEqual(keys(r).sort(), ['delta_flip', 'gex_flip', 'level:VAL']);
  assert.equal(r.candidate.score, 25 + 20 + 15);
  const c = r.candidate.conditions.find((k) => k.key === 'gex_flip')!;
  assert.equal(c.family, 'gex');
  assert.equal((c.detail as any).regime, 'above_flip');
});

test('SHORT needs price BELOW the flip; the LONG side is not credited there', () => {
  const sctx = ctx({ price: 119.8, flips: [{ direction: 'SHORT', ts: T }], gex: gex({ flipLevel: 121 }) });
  assert.ok(keys(evaluateDirection(sc, sctx, 'SHORT', undefined, undefined, gcfg)).includes('gex_flip'));
  assert.ok(!keys(evaluateDirection(sc, sctx, 'LONG', undefined, undefined, gcfg)).includes('gex_flip'));
  assert.ok(!keys(evaluateDirection(sc, ctx({ price: 100.3, gex: gex({ flipLevel: 105 }) }), 'LONG', undefined, undefined, gcfg)).includes('gex_flip'));
});

test('gex_flip is ignored when too close to the flip, stale, missing a flip, or unavailable (e.g. SOL)', () => {
  const no = (g: GexView | null | undefined) =>
    assert.ok(!keys(evaluateDirection(sc, ctx({ gex: g }), 'LONG', undefined, undefined, gcfg)).includes('gex_flip'));
  no(gex({ flipLevel: 100.25 })); // 0.05% above: inside the dead zone
  no(gex({ ts: T - 2_000_000 })); // older than maxAgeMs
  no(gex({ flipLevel: null }));
  no(null);
  no(undefined);
  assert.ok(keys(evaluateDirection(sc, ctx({ gex: gex({ flipLevel: 100.25 }) }), 'LONG', undefined, undefined, { ...gcfg, minDistancePct: 0 })).includes('gex_flip'));
});

test('GEX alone cannot make a signal (one extra family, still needs 3 conditions)', () => {
  const r = evaluateDirection(sc, ctx({ flips: [] }), 'LONG', undefined, undefined, gcfg);
  assert.ok(!r.ok && r.reason === 'min_conditions'); // level + gex = 2
});

// ---- replay / status / config ----------------------------------------------------------
test('replay applies stored GEX to BTC/ETH signals only; disabling it removes the condition', () => {
  const cfg = testConfig();
  const store = new Store(':memory:');
  const start = Date.parse('2026-01-01T00:00:00Z');
  store.insertTrades([...generateSynthetic(DEFAULT_SYNTH, start, 8, 7)]);
  for (let ts = start - 600_000; ts <= start + 9 * 3_600_000; ts += 300_000)
    for (const u of ['BTC', 'ETH', 'SOL']) store.insertGexSnapshot({ ...snap(u, ts, 1) }); // flip far below price: always "above flip"
  const res = runReplay(store, cfg, { runId: 'g' });
  assert.ok(res.gexSnapshots > 0);
  const by = (run: string) => store.db.prepare(
    `SELECT s.symbol, COUNT(*) c FROM signal_conditions sc JOIN signals s ON s.id = sc.signal_id
     WHERE s.run_id = ? AND sc.key = 'gex_flip' GROUP BY s.symbol`).all(run) as { symbol: string; c: number }[];
  const got = by('g');
  assert.ok(got.length > 0 && got.every((r) => r.c > 0));
  assert.ok(got.every((r) => r.symbol !== 'SOLUSDT'), 'SOL must never get a GEX condition even if snapshots exist');
  const off = runReplay(store, testConfig((c) => { c.gex.enabled = false; }), { runId: 'o' });
  assert.equal(off.gexSnapshots, 0);
  assert.deepEqual(by('o'), []);
});

test('status reports the flip level and distance', () => {
  const cfg = testConfig((c) => { c.assets.ETHUSDT.enabled = false; c.assets.SOLUSDT.enabled = false; });
  const store = new Store(':memory:');
  const pipeline = new Pipeline(cfg, { store, notifier: new MemoryNotifier() });
  const col = new LiveCollector(cfg, store, pipeline, { log: () => {} });
  pipeline.onTrade(trade(1000, 66000, 1));
  const src = { gexFor: (s: string) => (s === 'BTCUSDT' ? { underlying: 'BTC', ts: 0, spot: 66000, flipLevel: 65000, totalGex: 1 } : null) };
  const text = formatStatus(gatherStatus(col, pipeline, store, 0, 120_000, undefined, src));
  assert.match(text, /GEX BTCUSDT: flip 65000\.0 \(price 1\.54% above\)/);
  assert.doesNotMatch(formatStatus(gatherStatus(col, pipeline, store, 0, 120_000)), /GEX/);
});

test('config validation: BTC/ETH only, known assets, sane polling', () => {
  assert.throws(() => validateConfig(testConfig((c) => { (c.gex.underlyings as any).SOLUSDT = 'SOL'; })), /only BTC and ETH.*SOL options are too thin/);
  assert.throws(() => validateConfig(testConfig((c) => { (c.gex.underlyings as any).DOGEUSDT = 'BTC'; })), /unknown asset DOGEUSDT/);
  assert.throws(() => validateConfig(testConfig((c) => { c.gex.maxAgeMs = 1000; })), /maxAgeMs/);
  assert.doesNotThrow(() => validateConfig(testConfig((c) => { c.gex.enabled = false; (c.gex.underlyings as any).SOLUSDT = 'SOL'; })));
});
