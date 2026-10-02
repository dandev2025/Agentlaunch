# Agentlaunch — order-flow alerts & signals for BTC / ETH / SOL perps

Collects Binance USD-M futures `aggTrade` data, computes order-flow indicators, and sends **alerts and
scored LONG/SHORT signals to Telegram**. **There is no order execution anywhere in this code.**
Every alert and signal is logged to SQLite together with the inputs that triggered it, and every
signal's outcome (stop / T1 / T2, max move for and against) is tracked automatically.

Status: **all phases built:** Phase 1, 1B, footprint, heat map, GEX, confluence engine and the Next.js dashboard.

## Setup

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`, so there is no native SQLite dependency).
The only runtime dependency is `ws`. No paid API keys are used or needed.

```bash
npm install
cp .env.example .env        # optional: add TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
npm test                    # 136 tests (incl. the dashboard's data layer)
npm run typecheck
```

Without Telegram credentials, alerts print to the console instead.

**Telegram commands** (while `npm run collect` is running; only your `TELEGRAM_CHAT_ID` is answered, read-only):
`/status` shows uptime, WebSocket state and last-frame age, reconnects, gaps, per-asset price/trades/big trades/open signals,
24h alert and signal counts, and the last signal. `/help` lists commands. The bot uses long-polling, so don't run a webhook
or a second process polling the same bot (Telegram returns 409).

## Run

```bash
# Live: connect, store trades, fire alerts + signals   (export the .env vars first, or use `node --env-file=.env`)
npm run collect

# Backtest on stored trades — either your own collected data, or:
npm run backfill -- --hours 12                 # download recent aggTrades via Binance public REST
npm run seed-synthetic -- --hours 24           # FAKE data so you can try replay offline
npm run replay -- --run bt1                    # replay all rules, print report
npm run replay -- --run bt2 --config config/experiment.json --from 2026-01-01T06:00:00Z --symbols BTCUSDT
npm run report -- --run bt1 [--json] [--symbol ETHUSDT]   # `--run live` for live results
```

Replay uses the *same* engine code as live, with trade timestamps as the clock, and writes results
under its own `run_id`, so you can compare weight sets side by side. It never sends Telegram
messages unless you pass `--telegram`. Use `--db other.db` on any command to work on a different file.

## Dashboard (read-only)

A Next.js app in `dashboard/` that reads the collector's SQLite file. It is **read-only**: it opens the database in read-only mode
(it cannot write, create or migrate it, so it can't interfere with the collector) and has no way to place orders.

```bash
npm run dashboard:install                      # once (the dashboard has its own node_modules)
npm run dashboard                              # dev server, http://localhost:3000
npm run dashboard:build && npm run dashboard:start   # production
npm run seed-demo                              # optional: a complete demo DB of SYNTHETIC data -> data/demo.db
DB_PATH=data/demo.db npm run dashboard         # look at the demo data
```

Run it next to `npm run collect`; pages re-read the database every 10–60 s. Pages:

| Page | What it shows |
|---|---|
| Overview | per-asset health (last trade age, trades/5m), open signals, recent signals and alerts, 24h counts, data gaps, GEX flip |
| Signals / signal detail | filterable list (live or any backtest run); per signal: candle chart with entry zone, stop, targets and profile levels, the conditions that fired with their inputs, confluence breakdown, outcome and MFE/MAE |
| Alerts | what was sent to Telegram (or would have been, for backtests), with the inputs that triggered it |
| Performance | the backtest report in the browser: per condition / family / score bucket, and A/B compare of two runs |
| Heat map | order-book snapshots as a time × price heat map, with the price line and each wall's lifecycle (standing / pulled / eaten) |
| Footprint | bid × ask ladders per candle with imbalance marks, stacked imbalances and absorption (same rules as the signal engine) |
| GEX | per-strike gamma exposure, spot and flip level, flip history (BTC/ETH) |
| Profile | volume profile with POC / value area / HVNs rebuilt from stored trades |

Settings (environment variables): `DB_PATH` (default `data/orderflow.db`) and `CONFIG_PATH` (default `config/config.json`, the same file
the collector uses) — relative paths are relative to the **repo root**, absolute paths work too; `PORT` (default 3000), and optionally `DASHBOARD_PASSWORD` (+ `DASHBOARD_USER`,
default `admin`) to require HTTP Basic auth. **It has no login of its own by default — keep it on localhost, or set a password
and put it behind HTTPS, before exposing it.**

Notes: it uses Next.js 16 in webpack mode (`--webpack`) because it shares the collector's TypeScript (report, footprint and profile
code) and that code uses Node-style `.js` import suffixes, which Turbopack can't resolve. Times are UTC. The heat map and footprint pages
only have data for periods the collector was running with those features on; a replay run has no heat map or footprint data.

## How it works

```
Binance WS (/market aggTrade, /public depth) ─ reconnect/heartbeat ─ gap check (+REST backfill) ─┬─▶ SQLite trades
                                                                                   └─▶ AssetEngine (per symbol)
AssetEngine: candles+delta (1m/5m/15m) · big trades · rolling volume profile · ATR
   ├─ alert rules  → big trade at POC/HVN · delta divergence      → Telegram + alerts table
   └─ signal engine (evaluated each 1m close) → scored LONG/SHORT → Telegram + signals table → outcome tracker
```

### Collector robustness
- **Binance WebSocket endpoints.** Binance split the USDⓈ-M futures WebSocket by traffic type: trades (`<symbol>@aggTrade`) are on
  `<wsBaseUrl>/market`, the order book (`<symbol>@depth@500ms`) on `<wsBaseUrl>/public`. The old combined `/stream` URL now only
  delivers `/public` data, so trades silently stop. The collector therefore opens **one connection per endpoint** (the `/public` one only
  when the heat map is on), and `collector.wsBaseUrl` must be the root (`wss://fstream.binance.com`) — config validation rejects
  legacy/path-style URLs. If Binance changes this again, the collector says so: the `[status]` line shows message counts
  (`msgs agg=… depth=…`) and prints `[WARN]` if a connection is open but delivers nothing, or if frames can't be read.
- Auto-reconnect with exponential backoff + jitter; ping heartbeat; watchdog kills a connection that
  has produced no frames for `staleAfterMs`. Binance's 24h forced disconnect is handled the same way.
- **Gap detection:** aggTrade ids are consecutive, so any jump is a gap. It is logged to the `gaps`
  table and back-filled from REST `aggTrades?fromId=` *before* the live trade is processed. Backfilled
  trades update candles/profile/delta but never fire alerts or signals (they'd be stale).
- On startup the last `warmupMinutes` of stored trades are replayed silently so ATR, profile and delta
  history are warm.
- The depth stream feeds the heat map (see below); set `heatmap.enabled`/`collector.depth.enabled` to false to run trades-only.

### Indicators (`src/indicators`, each pure and unit-tested)
| Module | What |
|---|---|
| `candles.ts` | OHLC + buy/sell volume, per-candle delta, cumulative delta (CVD) |
| `bigTrades.ts` | per-asset threshold: `minQty` and/or `minNotionalUsd` (either triggers) |
| `volumeProfile.ts` | rolling window (default 24h), POC, 70% value area (VAH/VAL), HVNs (local maxima ≥ `hvnFactor`× mean bin volume) |
| `divergence.ts` | CVD divergence vs previous N candles; delta flip; 15m delta z-score |
| `atr.ts` | Wilder ATR |
| `gex.ts` | options gamma exposure from Deribit open interest: per-strike GEX, flip level (BTC/ETH only) |
| `walls.ts` | resting-wall lifecycle on the L2 book: added / changed / pulled / eaten / expired |
| `footprint.ts` | bid/ask volume per price bin per candle, diagonal stacked imbalance, absorption |

"At or near" a level = within `max(proximity.atrMult × ATR(5m), proximity.minBins × binSize)`
(percent-of-price until ATR is warm).

### Signal engine (`src/signals`)
Each 1m close, per asset and direction, conditions earn configurable points:

| Condition key | Family | LONG | SHORT |
|---|---|---|---|
| `level:VAL` / `level:VAH` / `level:POC` / `level:HVN` | profile | at/near VAL, POC or HVN as support | at/near VAH, POC or HVN as resistance |
| `delta_flip` | delta | 5m candle delta flips positive (size ≥ 0.5× recent avg) | flips negative |
| `divergence` | delta | bullish CVD divergence (5m/15m) | bearish |
| `big_prints` | bigtrades | big **buys** at the level outweigh big sells | mirror |

| `fp_stacked_imbalance` | footprint | stacked **buy** imbalance zone at the level | stacked **sell** imbalance |
| `fp_absorption` | footprint | sell absorption at the lows (aggressive selling absorbed, price closes back up) | buy absorption at the highs |

| `wall_holding` | heatmap | a bid wall holding just under price at the level | an ask wall holding just over price |

| `gex_flip` | gex | price above the GEX flip level (positive-gamma side), BTC/ETH only | price below the flip level |

Delta events stay valid for `conditionTtlMs` (20 min). A signal fires only if **all** hold:
1. ≥ `minConditions` (3, enforced by config validation) distinct conditions, from ≥ `minFamilies` (2) indicator families
2. score ≥ `threshold`
3. higher-timeframe filter passes: no LONG when the 15m CVD z-score ≤ −`strongZ`, no SHORT when ≥ +`strongZ`
4. a valid plan exists (ATR warm, ≥1 target) with R:R ≥ `minRR` (measured to `rrBasis` T1 or T2)
5. per asset+direction cooldown has elapsed

Plan: entry zone around the level (± `entryZoneAtr`×ATR, widened to include current price), stop =
level ∓ `stopAtrMult`×ATR, T1/T2 = next two profile levels (POC/VAH/VAL/HVN) in the trade direction at least
`minTargetAtr`×ATR away (if only one exists, T2 is ATR-projected and flagged as such).

### Confluence (`src/signals/confluence.ts`)
Conditions are not simply added up. Per signal:
1. **Family collapse** — within one indicator family the strongest condition counts fully and the others at `stackFactor` (0.5),
   so `delta_flip` + `divergence` (both from the same delta feed) don't count twice.
2. **Diversity bonus** — × `familyBonus` for how many independent families agree (3 → 1.1, 4 → 1.2, 5 → 1.3; 2 → 1.0).
3. **Conflict penalty** — opposing-direction evidence *at the current price* subtracts `conflict.weight` (0.5) × its family-collapsed
   score. It is gathered without needing a profile level (bearish footprint absorption near price counts against a long even with no
   resistance level there). Only `delta`, `bigtrades`, `footprint`, `heatmap` count as opposing: a level can be support *and*
   resistance (POC), and GEX is a one-sided regime, so `profile` and `gex` are excluded by default (`conflict.families`).

`score = (sum of family scores) × bonus − conflict`, and that is what `threshold` is compared to. The full breakdown (raw sum, family
scores, multiplier, conflict and the opposing conditions) is stored in each signal's `inputs.confluence` and shown in the Telegram
message. `signals.confluence.enabled = false` restores the old flat sum exactly. **All the multipliers are untuned guesses** — the
tools below exist so you can test them instead of trusting them:
- `npm run report` also breaks results down **per family**, **per score bucket** (does a higher score actually do better?) and **by family count**.
- A/B a scoring change on the same stored trades:
  ```bash
  npm run replay -- --run on  --no-report
  npm run replay -- --run off --no-report --config config/no-confluence.json   # a copy of config.json with confluence.enabled=false
  npm run compare -- --a off --b on
  ```
  `compare` matches signals by symbol/direction/time and shows those in both, only in A, only in B, with their outcomes. Cooldowns make
  the "only in" buckets partly an artefact (a signal one run takes can block a different one in the other), and it warns when buckets are small.

**Outcome tracking** is trade-by-trade, so stop-vs-target ordering is exact. Realised R: stop before T1 = −1R;
`t1Fraction` (50%) is banked at T1 and the rest runs to T2 or the original stop; unresolved signals expire
after `maxHoldMs` and are marked to market. Assumption: entry at the signal price (no slippage/fees modelled).

**Report** (`npm run report`): win rate, average R, total R, profit factor, MFE/MAE in R, split by
direction, asset and **per condition** — including "avg R without this condition" and lift, to guide weight tuning.

### Footprint (`src/indicators/footprint.ts`)
Per candle (default 5m; `footprint.timeframes`) and per price bin (`assets.*.footprintBin`, finer than the profile bin),
aggressive buys are recorded as **ask** volume and aggressive sells as **bid** volume.
- **Imbalance** is diagonal: buy at level *i* if `ask[i] ≥ ratio × bid[i-1]`; sell if `bid[i] ≥ ratio × ask[i+1]`
  (`imbalanceRatio`, default 3). A level must also hold ≥ `minVolFrac` (2%) of the candle's volume so thin levels are ignored.
- **Stacked** = ≥ `stackedMin` (3) consecutive same-side imbalances.
- **Absorption** = in the bottom (or top) `zoneFrac` of the candle's range, the dominant aggressive side has ≥ `minZoneShare`
  of candle volume and ≥ `dominanceRatio`× the other side, candle volume ≥ `volMult`× its recent average, and price
  closed back ≥ `rejectFrac` of the range away from the extreme.
- With `requireAtLevel` (default true) a footprint condition only counts when its zone is at/near the profile level the signal
  is built on, so imbalances in the middle of nowhere don't add points. Events are logged to `footprint_events`; levels to
  `footprint_levels` (live only). Inspect real candles with `npm run footprint -- --symbol BTCUSDT --tf 5m --last 3`.
- No separate footprint alert is sent in this phase; footprint feeds signal scoring only.

### Heat map (`src/collector/orderbook.ts`, `heatmap.ts`, `src/indicators/walls.ts`)
- **Book:** the collector subscribes to Binance's *diff* depth stream (`<symbol>@depth@500ms`) and keeps a local L2 book per
  symbol, synced from a REST snapshot (`/fapi/v1/depth`) using Binance's documented rules: drop events with `u < lastUpdateId`,
  the first applied event must cover the snapshot (`U ≤ lastUpdateId ≤ u`), later events must chain (`pu == previous u`).
  Any break, or a WebSocket reconnect, discards the book and resyncs. (The 20-level partial book is far too shallow for BTC.)
- **Snapshots:** every `snapshot.intervalMs` (30s) the book within ±`rangePct` (1%) of mid, aggregated to the asset's `binSize`,
  is stored in `orderbook_snapshots` (pruned after `retentionHours`). Raw full-depth history is deliberately *not* stored.
- **Walls:** each second, a level (bin) is a wall if its size ≥ max(`assets.*.wallMinQty`, `relMult` × median level size).
  It ends when size falls below `dropFrac` × its peak and is classified **eaten** (aggressive trades hit it for ≥ `eatenFrac` × peak,
  or price printed through it) or **pulled** (cancelled without being traded into; `spoofLike` if it lived < 10s untraded).
  **expired** means tracking stopped (left the range / book desynced) and implies nothing about intent. Lifecycles go to
  `book_walls` + `book_wall_events`; `npm run heatmap -- --symbol BTCUSDT --hours 6` lists them.
  Resolution is the tracking interval, so a pull immediately before a sweep can be mislabelled "eaten".
- **Alerts:** `pulled`/`eaten` walls within "near" of a POC/HVN/VAH/VAL level (`alerts.wall`, with cooldown).
- **Signal:** `wall_holding` — a wall on the protective side, within `near` of price, at least `minAgeMs` old (filters flash orders),
  still ≥ `holdFrac` of its peak, and (with `requireAtLevel`) at the profile level the signal is built on.
- **Replay:** walls are rebuilt from the stored lifecycle, so `wall_holding` is backtestable *for periods you were collecting*.
  Size is known at event granularity (changes ≥ `changeFrac`) and `executed` is not reconstructed. Wall alerts are live-only.
  `npm run replay` warns when the range has no stored walls.

### GEX (`src/indicators/gex.ts`, `src/collector/gex.ts`) — BTC and ETH only
- **Data:** Deribit's public `get_book_summary_by_currency` endpoint — free, **no API key**. It is polled every
  `pollIntervalMs` (5 min) for BTC and ETH only; SOL options are too thin, and config validation rejects any other currency.
- **Math:** per option, Black-Scholes gamma on the forward (r = 0) from Deribit's mark IV; GEX = OI × gamma × F² × 0.01
  (dollars of delta per 1% move), calls **+** and puts **−** (the usual "dealers are long calls / short puts" convention).
  Options expiring within `minHoursToExpiry` (their 0DTE gamma explodes) or beyond `maxDaysToExpiry` are ignored.
- **Flip level:** total GEX is re-evaluated with every forward scaled across ±`gridPct` of spot (OI and IV held fixed); the sign
  change nearest spot, linearly interpolated, is the flip. `null` if none exists in range.
- **Signal:** `gex_flip` — LONG when price is at least `minDistancePct` above the flip (positive-gamma side: dealer hedging tends to
  dampen moves), SHORT when at least that far below. A snapshot older than `maxAgeMs` is ignored, as is any asset without GEX data.
  This is a *regime* condition that is true for one of the two directions most of the time, so it is a weak filter on its own: it
  can't create a signal by itself, and the per-condition backtest report will show whether it earns its weight.
- **Replay:** snapshots are stored in `gex_snapshots`; replay uses the latest one at or before each moment (including the one that
  preceded the window). It warns when the range has none. `npm run gex -- --symbol BTCUSDT` shows the latest stored snapshot with
  the biggest strikes; `npm run gex -- --live` fetches Deribit right now (stores nothing) to check connectivity and numbers. `/status`
  shows the flip level and how far price is from it.
- **Caveats:** GEX is inferred from open interest, not observed dealer positioning, and the sign convention is an assumption.
  Deribit's index is spot, Binance's price is the perpetual, so there is a small basis. OI changes only a few times a day.

### Config (`config/config.json`)
Single file, validated on load: assets (enable/disable, `binSize`, big-trade thresholds), timeframes,
profile settings, alert rules and **cooldowns**, signal weights/threshold/filters/risk/tracking.
All defaults for BTC/ETH/SOL are **placeholders to tune against real data** — check them against
the actual size distribution you see (`big_trades` table) before trusting alerts.

## Database (SQLite, `data/orderflow.db`)
`trades` (symbol, agg_id, ts, price, size, side) · `candles` · `big_trades` · `alerts` (message + JSON inputs) ·
`signals` (plan, JSON inputs, outcome, MFE/MAE) · `signal_conditions` (one row per fired condition) · `gaps`.

`footprint_levels`/`footprint_events` (footprint) and `orderbook_snapshots`/`book_walls`/`book_wall_events` (heat map) are in use.
`gex_snapshots` (GEX) is in use. New signal conditions need no schema change — they are just new
`signal_conditions.key`/`family` values with weights in config. Migrations live in `src/db/migrations.ts`
(append-only, tracked by `PRAGMA user_version`); moving to Postgres/Supabase means swapping `src/db/store.ts`.

## Layout
```
config/config.json        src/core         types, formatting
src/config                loader+validation  src/db           migrations, Store
src/collector             binance ws, gaps/backfill, live runner
src/indicators            candles, atr, bigTrades, volumeProfile, divergence
src/alerts                cooldown, rules, telegram/console notifiers
src/signals               evaluate (pure scoring+plan), tracker, format
src/engine                AssetEngine, Pipeline        src/backtest   replay, report, synthetic data
src/cli                   collect, replay, report, backfill, seed-synthetic, seed-demo, footprint, heatmap, gex, compare
dashboard/                Next.js read-only dashboard (app/, components/, lib/ data layer, tests/)     tests/  node:test
```

## Caveats
- The first run against the real Binance feeds found two bugs that fakes couldn't (the trade endpoint split above, and an order-book
  resync loop), both fixed with regression tests. The code is much better exercised now, but treat the first days of live collection as
  a shakedown: watch the `[status]` and `[WARN]` lines, and send me anything odd.
- `seed-synthetic` data is fabricated (a mean-reverting random walk). Replay results on it only prove the
  pipeline works; they say nothing about edge. Judge weights on real data with a meaningful number of signals.
- Check `[heatmap]` log lines
  and `npm run heatmap` after a few hours of collecting; `wallMinQty` and `relMult` are untuned placeholders. Depth traffic is
  much heavier than trades alone (three symbols at 500ms).
- The Deribit client is tested against fakes only (the sandbox could not reach Deribit). Run `npm run gex -- --live` once to confirm the
  response shape (`instrument_name`, `open_interest`, `mark_iv`, `underlying_price`, `estimated_delivery_price`) and that the numbers look sane.
- CVD is cumulative since process/replay start, not exchange-session aligned.
