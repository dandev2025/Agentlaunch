import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { BigTrade, Candle, Direction, FootprintCandle, FootprintEvent, GexSnapshot, Trade, WallEventType, WallSide } from '../core/types.js';
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

export interface WallRow {
  id: number;
  symbol: string;
  side: WallSide;
  price: number;
  firstSeen: number;
  lastSeen: number;
  peak: number;
  lastSize: number;
  status: string;
  executed: number;
}

export const LIVE_RUN = 'live';

export class Store {
  readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  /** `readOnly` opens an existing database without creating it, changing its mode or migrating it (used by the dashboard). */
  constructor(path: string, readonly runId: string = LIVE_RUN, opts: { readOnly?: boolean } = {}) {
    if (opts.readOnly) {
      this.db = new DatabaseSync(path, { readOnly: true });
      return;
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  /** Number of migrations applied to this database. */
  get schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
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

  recordFootprint(fc: FootprintCandle): void {
    const s = this.st(
      'INSERT OR REPLACE INTO footprint_levels (symbol, tf, ts, price, bid_volume, ask_volume, trades) VALUES (?,?,?,?,?,?,?)',
    );
    this.tx(() => {
      for (const l of fc.levels) s.run(fc.symbol, fc.tf, fc.ts, l.price, l.bid, l.ask, l.trades);
    });
  }

  recordFootprintEvent(e: FootprintEvent): void {
    this.st(
      'INSERT INTO footprint_events (run_id, ts, symbol, tf, kind, direction, lo, hi, detail) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(this.runId, e.ts, e.symbol, e.tf, e.kind, e.direction, e.lo, e.hi, JSON.stringify(e.detail));
  }

  // ---- GEX ----------------------------------------------------------------
  insertGexSnapshot(g: GexSnapshot): void {
    this.st(
      `INSERT OR REPLACE INTO gex_snapshots (underlying, ts, spot, flip_level, total_gex, strikes, instruments)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(g.underlying, g.ts, g.spot, g.flipLevel, g.totalGex, JSON.stringify(g.strikes), g.instruments);
  }

  /** Snapshots for the given underlyings in [fromTs, toTs], oldest first. `withStrikes` pulls the JSON breakdown too. */
  loadGexSnapshots(underlyings: string[], fromTs: number, toTs: number, withStrikes = false): GexSnapshot[] {
    const ph = underlyings.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT underlying, ts, spot, flip_level, total_gex, instruments ${withStrikes ? ', strikes' : ''} FROM gex_snapshots
         WHERE underlying IN (${ph}) AND ts >= ? AND ts <= ? ORDER BY ts`,
      )
      .all(...underlyings, fromTs, toTs) as Record<string, any>[];
    return rows.map((r) => ({
      underlying: r.underlying, ts: r.ts, spot: r.spot, flipLevel: r.flip_level, totalGex: r.total_gex,
      strikes: withStrikes && r.strikes ? JSON.parse(r.strikes) : [], instruments: r.instruments ?? 0,
    }));
  }

  /** Latest snapshot at or before `ts` (used to warm replay with the snapshot that preceded its window). */
  latestGexBefore(underlying: string, ts: number): GexSnapshot | null {
    const r = this.db
      .prepare('SELECT ts FROM gex_snapshots WHERE underlying = ? AND ts <= ? ORDER BY ts DESC LIMIT 1')
      .get(underlying, ts) as { ts: number } | undefined;
    return r ? this.loadGexSnapshots([underlying], r.ts, r.ts)[0] : null;
  }

  // ---- heat map -----------------------------------------------------------
  recordOrderbookSnapshot(symbol: string, ts: number, bids: [number, number][], asks: [number, number][]): void {
    this.st('INSERT OR REPLACE INTO orderbook_snapshots (symbol, ts, bids, asks) VALUES (?,?,?,?)').run(
      symbol, ts, JSON.stringify(bids), JSON.stringify(asks),
    );
  }

  pruneOrderbookSnapshots(beforeTs: number): number {
    return Number(this.st('DELETE FROM orderbook_snapshots WHERE ts < ?').run(beforeTs).changes);
  }

  insertWall(w: { symbol: string; side: WallSide; price: number; ts: number; size: number }): number {
    const r = this.st(
      `INSERT INTO book_walls (symbol, side, price, first_seen, last_seen, peak_size, last_size, status)
       VALUES (?,?,?,?,?,?,?, 'active')`,
    ).run(w.symbol, w.side, w.price, w.ts, w.ts, w.size, w.size);
    return Number(r.lastInsertRowid);
  }

  updateWall(id: number, u: { ts: number; size: number; peak: number; executed: number; status?: string; detail?: unknown }): void {
    this.st(
      `UPDATE book_walls SET last_seen = ?, last_size = ?, peak_size = ?, executed = ?,
         status = COALESCE(?, status), detail = COALESCE(?, detail) WHERE id = ?`,
    ).run(u.ts, u.size, u.peak, u.executed, u.status ?? null, u.detail === undefined ? null : JSON.stringify(u.detail), id);
  }

  recordWallEvent(wallId: number, ts: number, type: WallEventType, size: number): void {
    this.st('INSERT INTO book_wall_events (wall_id, ts, type, size) VALUES (?,?,?,?)').run(wallId, ts, type, size);
  }

  /** Walls still marked active when the process starts were orphaned by a restart: close them at their last update. */
  closeStaleWalls(): number {
    return Number(this.st("UPDATE book_walls SET status = 'expired' WHERE status = 'active'").run().changes);
  }

  loadWalls(symbols: string[], fromTs: number, toTs: number): WallRow[] {
    const ph = symbols.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id, symbol, side, price, first_seen, last_seen, peak_size, last_size, status, executed FROM book_walls
         WHERE symbol IN (${ph}) AND last_seen >= ? AND first_seen <= ? ORDER BY first_seen`,
      )
      .all(...symbols, fromTs, toTs) as Record<string, any>[];
    return rows.map((r) => ({
      id: r.id, symbol: r.symbol, side: r.side, price: r.price, firstSeen: r.first_seen, lastSeen: r.last_seen,
      peak: r.peak_size, lastSize: r.last_size, status: r.status, executed: r.executed,
    }));
  }

  loadWallEvents(wallIds: number[]): { wallId: number; ts: number; type: WallEventType; size: number }[] {
    const out: { wallId: number; ts: number; type: WallEventType; size: number }[] = [];
    const s = this.db.prepare('SELECT wall_id, ts, type, size FROM book_wall_events WHERE wall_id = ? ORDER BY ts, id');
    for (const id of wallIds)
      for (const r of s.all(id) as Record<string, any>[]) out.push({ wallId: r.wall_id, ts: r.ts, type: r.type, size: r.size });
    return out;
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
