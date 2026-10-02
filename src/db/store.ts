import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { BigTrade, Candle, Direction, Trade } from '../core/types.js';
import { MIGRATIONS } from './migrations.js';

export interface SignalRow {
  id: number;
  runId: string;
  ts: number;
  symbol: string;
  direction: Direction;
  score: number;
  entry: number;
  stop: number;
  t1: number;
  t2: number;
  atr: number;
}

export interface NewSignal {
  ts: number;
  symbol: string;
  direction: Direction;
  score: number;
  entry: number;
  entryLo: number;
  entryHi: number;
  stop: number;
  t1: number;
  t2: number;
  rr: number;
  rrT1: number;
  rrT2: number;
  atr: number;
  inputs: unknown;
  conditions: { key: string; family: string; points: number; detail?: unknown }[];
}

export interface SignalUpdate {
  t1Ts?: number | null;
  t2Ts?: number | null;
  stopTs?: number | null;
  closedTs?: number | null;
  outcome?: string | null;
  realizedR?: number | null;
  maxFavorable: number;
  maxAdverse: number;
  maxFavorableR: number;
  maxAdverseR: number;
  closed: boolean;
}

export const LIVE_RUN = 'live';

export class Store {
  readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(path: string, readonly runId: string = LIVE_RUN) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  /** A view of the same connection that writes under a different run id. */
  withRun(runId: string): Store {
    const s = Object.create(this) as { runId: string };
    s.runId = runId;
    return s as unknown as Store;
  }

  private migrate(): void {
    const v = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[i]);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  /** Transaction that nests safely (uses a savepoint when one is already open, e.g. during replay). */
  private tx<T>(fn: () => T): T {
    const nested = this.db.isTransaction;
    const sp = 'sp_tx';
    this.db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN');
    try {
      const r = fn();
      this.db.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
      return r;
    } catch (e) {
      this.db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
      throw e;
    }
  }

  private st(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  close(): void {
    this.db.close();
  }

  // ---- trades -------------------------------------------------------------
  insertTrades(trades: Trade[]): number {
    if (!trades.length) return 0;
    const s = this.st('INSERT OR IGNORE INTO trades (symbol, agg_id, ts, price, size, side) VALUES (?,?,?,?,?,?)');
    return this.tx(() => {
      let n = 0;
      for (const t of trades) n += Number(s.run(t.symbol, t.aggId, t.ts, t.price, t.size, t.side === 'buy' ? 1 : -1).changes);
      return n;
    });
  }

  *iterTrades(symbols: string[], fromTs: number, toTs: number): Generator<Trade> {
    const ph = symbols.map(() => '?').join(',');
    const s = this.db.prepare(
      `SELECT symbol, agg_id, ts, price, size, side FROM trades
       WHERE symbol IN (${ph}) AND ts >= ? AND ts <= ? ORDER BY ts, symbol, agg_id`,
    );
    for (const r of s.iterate(...symbols, fromTs, toTs) as Iterable<Record<string, number | string>>) {
      yield {
        symbol: r.symbol as string,
        aggId: r.agg_id as number,
        ts: r.ts as number,
        price: r.price as number,
        size: r.size as number,
        side: (r.side as number) > 0 ? 'buy' : 'sell',
      };
    }
  }

  tradeRange(symbols: string[]): { min: number; max: number; count: number } | null {
    const ph = symbols.map(() => '?').join(',');
    const r = this.db
      .prepare(`SELECT MIN(ts) AS min, MAX(ts) AS max, COUNT(*) AS count FROM trades WHERE symbol IN (${ph})`)
      .get(...symbols) as { min: number | null; max: number | null; count: number };
    return r.min == null ? null : { min: r.min, max: r.max!, count: r.count };
  }

  lastAggId(symbol: string): number | null {
    const r = this.st('SELECT MAX(agg_id) AS m FROM trades WHERE symbol = ?').get(symbol) as { m: number | null };
    return r.m;
  }

  recordGap(symbol: string, ts: number, fromId: number, toId: number, recovered: number): void {
    this.st('INSERT INTO gaps (symbol, detected_ts, from_id, to_id, missing, recovered) VALUES (?,?,?,?,?,?)').run(
      symbol, ts, fromId, toId, toId - fromId + 1, recovered,
    );
  }

  // ---- derived data -------------------------------------------------------
  recordCandle(c: Candle): void {
    this.st(
      `INSERT OR REPLACE INTO candles (symbol, tf, ts, open, high, low, close, volume, buy_volume, sell_volume, delta, cvd, trades)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(c.symbol, c.tf, c.ts, c.open, c.high, c.low, c.close, c.volume, c.buyVolume, c.sellVolume, c.delta, c.cvd, c.trades);
  }

  recordBigTrade(b: BigTrade): void {
    this.st(
      'INSERT INTO big_trades (run_id, symbol, ts, agg_id, price, size, notional, side) VALUES (?,?,?,?,?,?,?,?)',
    ).run(this.runId, b.symbol, b.ts, b.aggId, b.price, b.size, b.notional, b.side === 'buy' ? 1 : -1);
  }

  recordAlert(ts: number, symbol: string, type: string, message: string, inputs: unknown): void {
    this.st('INSERT INTO alerts (run_id, ts, symbol, type, message, inputs) VALUES (?,?,?,?,?,?)').run(
      this.runId, ts, symbol, type, message, JSON.stringify(inputs),
    );
  }

  // ---- signals ------------------------------------------------------------
  insertSignal(s: NewSignal): number {
    return this.tx(() => {
      const r = this.st(
        `INSERT INTO signals (run_id, ts, symbol, direction, score, entry, entry_lo, entry_hi, stop, t1, t2,
                              rr, rr_t1, rr_t2, atr, inputs)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        this.runId, s.ts, s.symbol, s.direction, s.score, s.entry, s.entryLo, s.entryHi, s.stop, s.t1, s.t2,
        s.rr, s.rrT1, s.rrT2, s.atr, JSON.stringify(s.inputs),
      );
      const id = Number(r.lastInsertRowid);
      const c = this.st('INSERT INTO signal_conditions (signal_id, key, family, points, detail) VALUES (?,?,?,?,?)');
      for (const k of s.conditions) c.run(id, k.key, k.family, k.points, k.detail === undefined ? null : JSON.stringify(k.detail));
      return id;
    });
  }

  updateSignal(id: number, u: SignalUpdate): void {
    this.st(
      `UPDATE signals SET t1_ts = COALESCE(?, t1_ts), t2_ts = COALESCE(?, t2_ts), stop_ts = COALESCE(?, stop_ts),
         closed_ts = COALESCE(?, closed_ts), outcome = COALESCE(?, outcome), realized_r = COALESCE(?, realized_r),
         max_favorable = ?, max_adverse = ?, max_favorable_r = ?, max_adverse_r = ?,
         status = CASE WHEN ? THEN 'CLOSED' ELSE status END
       WHERE id = ?`,
    ).run(
      u.t1Ts ?? null, u.t2Ts ?? null, u.stopTs ?? null, u.closedTs ?? null, u.outcome ?? null, u.realizedR ?? null,
      u.maxFavorable, u.maxAdverse, u.maxFavorableR, u.maxAdverseR, u.closed ? 1 : 0, id,
    );
  }

  loadOpenSignals(symbol?: string): (SignalRow & { t1Hit: boolean })[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, ts, symbol, direction, score, entry, stop, t1, t2, atr, t1_ts FROM signals
         WHERE run_id = ? AND status = 'OPEN' ${symbol ? 'AND symbol = ?' : ''}`,
      )
      .all(...(symbol ? [this.runId, symbol] : [this.runId])) as Record<string, number | string | null>[];
    return rows.map((r) => ({
      id: r.id as number, runId: r.run_id as string, ts: r.ts as number, symbol: r.symbol as string,
      direction: r.direction as Direction, score: r.score as number, entry: r.entry as number,
      stop: r.stop as number, t1: r.t1 as number, t2: r.t2 as number, atr: r.atr as number,
      t1Hit: r.t1_ts != null,
    }));
  }
}
