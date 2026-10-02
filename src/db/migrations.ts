/** Ordered migrations; PRAGMA user_version tracks how many have been applied. */
export const MIGRATIONS: string[] = [
  // 1 — Phase 1 / 1B
  `
  CREATE TABLE trades (
    symbol TEXT NOT NULL,
    agg_id INTEGER NOT NULL,
    ts     INTEGER NOT NULL,
    price  REAL NOT NULL,
    size   REAL NOT NULL,
    side   INTEGER NOT NULL,            -- +1 aggressor buy, -1 aggressor sell
    PRIMARY KEY (symbol, agg_id)
  ) WITHOUT ROWID;
  CREATE INDEX idx_trades_ts ON trades (symbol, ts);

  CREATE TABLE gaps (
    id INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL,
    detected_ts INTEGER NOT NULL,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    missing INTEGER NOT NULL,
    recovered INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE candles (
    symbol TEXT NOT NULL, tf TEXT NOT NULL, ts INTEGER NOT NULL,
    open REAL, high REAL, low REAL, close REAL,
    volume REAL, buy_volume REAL, sell_volume REAL,
    delta REAL, cvd REAL, trades INTEGER,
    PRIMARY KEY (symbol, tf, ts)
  ) WITHOUT ROWID;

  CREATE TABLE big_trades (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL, symbol TEXT NOT NULL, ts INTEGER NOT NULL, agg_id INTEGER NOT NULL,
    price REAL, size REAL, notional REAL, side INTEGER
  );
  CREATE INDEX idx_big_trades ON big_trades (run_id, symbol, ts);

  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL, ts INTEGER NOT NULL, symbol TEXT NOT NULL,
    type TEXT NOT NULL,                 -- big_trade_at_level | delta_divergence | ...
    message TEXT NOT NULL,
    inputs TEXT NOT NULL                -- JSON: everything that triggered the alert
  );
  CREATE INDEX idx_alerts ON alerts (run_id, symbol, ts);

  CREATE TABLE signals (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL, ts INTEGER NOT NULL, symbol TEXT NOT NULL,
    direction TEXT NOT NULL, score REAL NOT NULL,
    entry REAL, entry_lo REAL, entry_hi REAL, stop REAL, t1 REAL, t2 REAL,
    rr REAL, rr_t1 REAL, rr_t2 REAL, atr REAL,
    inputs TEXT NOT NULL,               -- JSON: profile snapshot, htf, events, thresholds used
    status TEXT NOT NULL DEFAULT 'OPEN',-- OPEN | CLOSED
    outcome TEXT,                       -- STOP | T1 | T2 | EXPIRED
    t1_ts INTEGER, t2_ts INTEGER, stop_ts INTEGER, closed_ts INTEGER,
    realized_r REAL,
    max_favorable REAL NOT NULL DEFAULT 0, max_adverse REAL NOT NULL DEFAULT 0,
    max_favorable_r REAL NOT NULL DEFAULT 0, max_adverse_r REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_signals ON signals (run_id, symbol, ts);

  CREATE TABLE signal_conditions (
    signal_id INTEGER NOT NULL REFERENCES signals(id),
    key TEXT NOT NULL,                  -- e.g. level:VAL, delta_flip, divergence, big_prints
    family TEXT NOT NULL,               -- profile | delta | bigtrades | heatmap | footprint | gex
    points REAL NOT NULL,
    detail TEXT,
    PRIMARY KEY (signal_id, key)
  ) WITHOUT ROWID;
  `,
  // 2 — Reserved for later phases. Tables only; nothing writes to them yet.
  `
  -- Heat map: raw L2 snapshots + tracked resting walls
  CREATE TABLE orderbook_snapshots (
    symbol TEXT NOT NULL, ts INTEGER NOT NULL,
    bids TEXT NOT NULL, asks TEXT NOT NULL,   -- JSON [[price,qty],...]
    PRIMARY KEY (symbol, ts)
  ) WITHOUT ROWID;
  CREATE TABLE book_walls (
    id INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    peak_size REAL NOT NULL, last_size REAL NOT NULL,
    status TEXT NOT NULL                      -- active | pulled | eaten
  );
  -- Footprint: bid/ask volume per price level per candle
  CREATE TABLE footprint_levels (
    symbol TEXT NOT NULL, tf TEXT NOT NULL, ts INTEGER NOT NULL, price REAL NOT NULL,
    bid_volume REAL NOT NULL, ask_volume REAL NOT NULL, trades INTEGER NOT NULL,
    PRIMARY KEY (symbol, tf, ts, price)
  ) WITHOUT ROWID;
  -- GEX (Deribit options, BTC/ETH only)
  CREATE TABLE gex_snapshots (
    underlying TEXT NOT NULL, ts INTEGER NOT NULL,
    spot REAL, flip_level REAL, total_gex REAL,
    strikes TEXT,                             -- JSON [{strike, gex}]
    PRIMARY KEY (underlying, ts)
  ) WITHOUT ROWID;
  `,
  // 3 — Footprint phase: detected events are logged per run so they can be tuned / audited.
  `
  CREATE TABLE footprint_events (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL, ts INTEGER NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
    kind TEXT NOT NULL,                 -- stacked_imbalance | absorption
    direction TEXT NOT NULL,            -- LONG | SHORT (what it supports)
    lo REAL NOT NULL, hi REAL NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX idx_footprint_events ON footprint_events (run_id, symbol, ts);
  `,
  // 4 — Heat map phase: wall lifecycle detail. Walls and their size timeline are market observations
  // (like trades/candles), not per-run output, so replay can rebuild wall state from them.
  `
  ALTER TABLE book_walls ADD COLUMN executed REAL NOT NULL DEFAULT 0;
  ALTER TABLE book_walls ADD COLUMN detail TEXT;
  CREATE INDEX idx_book_walls ON book_walls (symbol, first_seen);
  CREATE TABLE book_wall_events (
    id INTEGER PRIMARY KEY,
    wall_id INTEGER NOT NULL REFERENCES book_walls(id),
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,                 -- added | changed | pulled | eaten | expired
    size REAL NOT NULL
  );
  CREATE INDEX idx_book_wall_events ON book_wall_events (wall_id, ts);
  `,
  // 5 — GEX phase: how many instruments fed a snapshot (data-quality check for thin books).
  `
  ALTER TABLE gex_snapshots ADD COLUMN instruments INTEGER;
  `,
];
