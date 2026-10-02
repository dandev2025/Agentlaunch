# Agentlaunch — order-flow alerts & signals for BTC / ETH / SOL perps

Collects Binance USD-M futures `aggTrade` data, computes order-flow indicators, and sends **alerts and
scored LONG/SHORT signals to Telegram**. **There is no order execution anywhere in this code.**
Every alert and signal is logged to SQLite together with the inputs that triggered it, and every
signal's outcome (stop / T1 / T2, max move for and against) is tracked automatically.

Status: **Phase 1, 1B, Footprint and Heat map built.** GEX, the confluence engine and the Next.js dashboard are
later phases (schema is already reserved, see below).

## Setup

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`, so there is no native SQLite dependency).
The only runtime dependency is `ws`. No paid API keys are used or needed.

```bash
npm install
cp .env.example .env        # optional: add TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
npm test                    # 88 tests
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

## How it works

```
Binance WS (aggTrade [+depth]) ─ reconnect/heartbeat ─ gap check (+REST backfill) ─┬─▶ SQLite trades
                                                                                   └─▶ AssetEngine (per symbol)
AssetEngine: candles+delta (1m/5m/15m) · big trades · rolling volume profile · ATR
   ├─ alert rules  → big trade at POC/HVN · delta divergence      → Telegram + alerts table
   └─ signal engine (evaluated each 1m close) → scored LONG/SHORT → Telegram + signals table → outcome tracker
```

### Collector robustness
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

Delta events stay valid for `conditionTtlMs` (20 min). A signal fires only if **all** hold:
1. ≥ `minConditions` (3, enforced by config validation) distinct conditions, from ≥ `minFamilies` (2) indicator families
2. score ≥ `threshold`
3. higher-timeframe filter passes: no LONG when the 15m CVD z-score ≤ −`strongZ`, no SHORT when ≥ +`strongZ`
4. a valid plan exists (ATR warm, ≥1 target) with R:R ≥ `minRR` (measured to `rrBasis` T1 or T2)
5. per asset+direction cooldown has elapsed

Plan: entry zone around the level (± `entryZoneAtr`×ATR, widened to include current price), stop =
level ∓ `stopAtrMult`×ATR, T1/T2 = next two profile levels (POC/VAH/VAL/HVN) in the trade direction at least
`minTargetAtr`×ATR away (if only one exists, T2 is ATR-projected and flagged as such).

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

### Config (`config/config.json`)
Single file, validated on load: assets (enable/disable, `binSize`, big-trade thresholds), timeframes,
profile settings, alert rules and **cooldowns**, signal weights/threshold/filters/risk/tracking.
All defaults for BTC/ETH/SOL are **placeholders to tune against real data** — check them against
the actual size distribution you see (`big_trades` table) before trusting alerts.

## Database (SQLite, `data/orderflow.db`)
`trades` (symbol, agg_id, ts, price, size, side) · `candles` · `big_trades` · `alerts` (message + JSON inputs) ·
`signals` (plan, JSON inputs, outcome, MFE/MAE) · `signal_conditions` (one row per fired condition) · `gaps`.

`footprint_levels`/`footprint_events` (footprint) and `orderbook_snapshots`/`book_walls`/`book_wall_events` (heat map) are in use.
Reserved for a later phase (created, unused): `gex_snapshots`. New signal conditions need no schema change — they are just new
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
src/cli                   collect, replay, report, backfill, seed-synthetic, footprint, heatmap     tests/  node:test
```

## Caveats
- Written and tested in an environment where Binance was unreachable. The WebSocket client, gap
  recovery and live runner are tested against a fake socket/REST (reconnect, stale watchdog, gap backfill),
  but **not yet against the live exchange**. Run `npm run collect` and watch the `[collector]` log first.
  Binance has been reorganising futures WebSocket endpoints; if the default `wsBaseUrl` is rejected, check
  Binance's current docs and change `collector.wsBaseUrl`.
- `seed-synthetic` data is fabricated (a mean-reverting random walk). Replay results on it only prove the
  pipeline works; they say nothing about edge. Judge weights on real data with a meaningful number of signals.
- The order-book sync and wall tracking are tested against a fake exchange, not the real depth feed. Check `[heatmap]` log lines
  and `npm run heatmap` after a few hours of collecting; `wallMinQty` and `relMult` are untuned placeholders. Depth traffic is
  much heavier than trades alone (three symbols at 500ms).
- CVD is cumulative since process/replay start, not exchange-session aligned.
