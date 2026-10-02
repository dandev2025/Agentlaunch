import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/store.js';
import { runReplay } from '../src/backtest/replay.js';
import { buildReport } from '../src/backtest/report.js';
import { DEFAULT_SYNTH, generateSynthetic } from '../src/backtest/synthetic.js';
import { loadConfig, validateConfig } from '../src/config/load.js';
import { testConfig, trade } from './helpers.js';

test('schema includes reserved tables for heat map / footprint / GEX', () => {
  const s = new Store(':memory:');
  const names = (s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  for (const t of ['trades', 'signals', 'signal_conditions', 'alerts', 'orderbook_snapshots', 'book_walls', 'footprint_levels', 'gex_snapshots'])
    assert.ok(names.includes(t), t);
});

test('trades: ignore duplicates, keep aggressor side, ordered iteration', () => {
  const s = new Store(':memory:');
  const a = trade(2000, 100, 1, 'sell');
  assert.equal(s.insertTrades([trade(1000, 99, 2, 'buy'), a, a]), 2);
  const got = [...s.iterTrades(['BTCUSDT'], 0, 1e9)];
  assert.deepEqual(got.map((t) => [t.ts, t.side]), [[1000, 'buy'], [2000, 'sell']]);
});

test('config validation rejects <3 min conditions and missing thresholds', () => {
  assert.doesNotThrow(() => loadConfig('config/config.json'));
  assert.throws(() => validateConfig(testConfig((c) => { c.signals.minConditions = 2; })), /minConditions/);
  assert.throws(() => validateConfig(testConfig((c) => { c.assets.BTCUSDT.bigTrade = { minQty: null, minNotionalUsd: null }; })), /bigTrade/);
});

function seeded(hours: number) {
  const store = new Store(':memory:');
  const cfg = testConfig();
  const batch = [...generateSynthetic(DEFAULT_SYNTH, Date.parse('2026-01-01T00:00:00Z'), hours, 7)];
  store.insertTrades(batch);
  return { store, cfg, n: batch.length };
}

test('replay is deterministic, logs inputs for every alert/signal, and report reconciles', () => {
  const { store, cfg, n } = seeded(8);
  const r1 = runReplay(store, cfg, { runId: 'a' });
  const r2 = runReplay(store, cfg, { runId: 'b' });
  assert.equal(r1.trades, n);
  assert.deepEqual(r1.perSymbol, r2.perSymbol);

  const q = (sql: string, ...a: any[]) => store.db.prepare(sql).all(...a) as any[];
  const alerts = q("SELECT * FROM alerts WHERE run_id='a'");
  assert.ok(alerts.length > 0, 'synthetic data should produce alerts');
  for (const a of alerts) assert.ok(Object.keys(JSON.parse(a.inputs)).length > 0);

  const sigs = q("SELECT * FROM signals WHERE run_id='a'");
  assert.equal(sigs.length, q("SELECT * FROM signals WHERE run_id='b'").length);
  assert.ok(sigs.length > 0, 'synthetic data should produce signals');
  for (const s of sigs) {
    const inputs = JSON.parse(s.inputs);
    assert.ok(inputs.profile && inputs.atr > 0 && inputs.weights);
    const conds = q('SELECT * FROM signal_conditions WHERE signal_id = ?', s.id);
    assert.ok(conds.length >= 3, 'every signal has >=3 conditions');
    assert.ok(s.rr >= cfg.signals.risk.minRR);
    assert.ok(s.direction === 'LONG' ? s.stop < s.entry && s.entry < s.t1 && s.t1 < s.t2 : s.stop > s.entry && s.entry > s.t1 && s.t1 > s.t2);
  }
  // cooldown: same asset+direction signals are spaced >= cooldown apart
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) for (const d of ['LONG', 'SHORT']) {
    const ts = sigs.filter((s) => s.symbol === sym && s.direction === d).map((s) => s.ts);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= cfg.signals.cooldownMs);
  }
  const rep = buildReport(store, 'a');
  assert.equal(rep.total, sigs.length);
  assert.equal(rep.overall.n + rep.open, sigs.length);
  assert.ok(Math.abs(rep.overall.totalR - sigs.reduce((a, s) => a + (s.realized_r ?? 0), 0)) < 1e-9);
});

test('replay respects from/to and silent warm-up (no alerts before from)', () => {
  const { store, cfg } = seeded(6);
  const from = Date.parse('2026-01-01T03:00:00Z');
  runReplay(store, cfg, { runId: 'w', fromTs: from, warmupMinutes: 120 });
  const early = store.db.prepare("SELECT COUNT(*) c FROM alerts WHERE run_id='w' AND ts < ?").get(from) as any;
  assert.equal(early.c, 0);
});

test('alert cooldown limits spam in replay', () => {
  const { store, cfg } = seeded(6);
  runReplay(store, cfg, { runId: 'c' });
  const rows = store.db.prepare("SELECT ts, symbol, inputs FROM alerts WHERE run_id='c' AND type='big_trade_at_level'").all() as any[];
  const byKey = new Map<string, number[]>();
  for (const r of rows) {
    const i = JSON.parse(r.inputs);
    const k = `${r.symbol}:${i.trade.side}:${i.level.kind}:${i.level.price}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r.ts]);
  }
  for (const ts of byKey.values()) for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= cfg.alerts.bigTradeAtLevel.cooldownMs);
});
