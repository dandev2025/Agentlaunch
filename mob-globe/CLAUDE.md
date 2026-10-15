# Mob Globe (MemeMobbing) - project brief for Claude Code

## What this is
A live, visual tracker: a 3D dotted globe showing real-time Solana token buys and sells. Buys fly IN to the globe, sells fly OUT. It shows roughly which world region trades come from, plus a leaderboard, token detail view, tracked wallets and a full-screen "content mode" for screen recording. Owner: Dan (solo builder, Reading UK, mostly on iPhone, M1 MacBook Air for builds). Brand: MemeMobbing (black + orange, orange blob mascot, Permanent Marker font, tagline "Stay close.").

## Accounts
Dan is creating a SEPARATE Helius account and a SEPARATE Supabase account for this app (not shared with Mob Score). Keys go only in this folder's `.env`.

## Hard rules (from the owner)
- It is a VISUAL TRACKER ONLY. No Mob Score, rug/risk scoring or buy/sell advice in this app.
- Be honest about location: blockchains have no location. Regions are ESTIMATES from each wallet's trading hours. Always label them "estimated". Never claim exact locations.
- Secrets (Helius, Supabase service key, Telegram token) live only in server `.env`. Never in the browser, the repo, or chat. Use a NEW Supabase project, separate from Mob Score.
- Use the artwork in /assets exactly as given (do not redraw the mascot). index.html currently embeds a cutout of it plus a transparent sticker-sheet tile as base64.
- Dan is UK based: if this ever promotes a token or paid signals, FCA crypto-promotion rules may apply. Flag it, don't give legal advice.

## Files
- `server.js` - Node 18+ ESM relay (`ws`). Serves index.html and a WebSocket at `/stream`.
  - pump.fun: PumpPortal `wss://pumpportal.fun/api/data` (`subscribeNewToken`, `subscribeTokenTrade` for the newest 300 mints, `subscribeAccountTrade` for tracked wallets).
  - Jupiter/Raydium/Orca/Meteora: Solana RPC (Helius) `logsSubscribe` per program id, then `getTransaction` (jsonParsed) decoded from the signer's SOL/USDC/token balance deltas. Token symbol/logo from DexScreener, SOL price from CoinGecko. Needs `HELIUS_KEY`.
  - Region estimate: naive-Bayes over the UTC hours a wallet trades (1-2 trades = weighted guess, 3+ = best match). Bot rule: 8+ trades in 60s, or 15+ trades over 16+ UTC hours; bots get no location and are only counted.
  - Sampling: small pump.fun trades capped ~8/s; DEX swaps decoded at `DECODE_PER_SEC` (default 0.4/s). Each decode is a Helius `getTransaction` = 1 credit; the Free plan is 1M credits/month and 10 req/s (checked Oct 2026), so 0.4/s is about the monthly budget. Tracked wallets bypass sampling. pump.fun uses no Helius credits.
- `index.html` - single file front end: canvas globe (hand-drawn coastline polygons `L`), bubbles, stats, pressure bar, regional leaderboard, token detail sheet with wallets/Solscan links, wallet tracking (localStorage + `{pin}` messages), bot counter, content mode. Falls back to simulated DEMO data if the WebSocket is unavailable.
- `supabase/schema.sql` - DRAFT schema (not applied).

## Honest state
Everything was written in a sandbox with NO internet access. `node --check` passes and the UI was screenshot-tested in demo mode, but the live data path has NEVER been run. Treat these as unverified assumptions and fix against real traffic:
- PumpPortal message fields (`txType` create/buy/sell, `solAmount`, `traderPublicKey`, `signature`, `mint`, `symbol`, `uri`).
- Helius websocket/RPC behaviour and free-tier rate limits; the decode heuristics (token-for-token swaps are skipped, USDT is not treated as a quote, Jito tips skew SOL deltas slightly).
- DexScreener / CoinGecko response shapes and rate limits.
- Canvas taint: remote logos make `toDataURL` throw; `icon()` falls back to a letter coin. Consider proxying logos through the relay.

## Known improvements
- Tokens are keyed by SYMBOL in the UI, so same-ticker tokens collide. Key by mint.
- Coastlines are hand-drawn; swap in Natural Earth 110m land data served locally (not a CDN).
- Extract the base64 assets from index.html into /public and split the file once it stabilises.

## Task list (in order)
1. Run it (`npm install`, `HELIUS_KEY=... npm start`, open http://localhost:8080). Get the badge from DEMO to LIVE and fix whatever breaks. Add recorded-message fixtures and tests for the decode logic.
2. Supabase persistence: review/apply `supabase/schema.sql`; batch writes from the relay every few seconds (per-minute flow rows, big trades >= ~$5k, wallet stats, tracked wallets synced across devices); hourly rollups; read-only access for the browser; daily/weekly flow charts in the UI.
3. Deploy the relay (Railway or Render): origin allowlist, per-IP rate limits, reconnect/backoff, health check, graceful shutdown.
4. Telegram alerts via Dan's existing bot: "Mob Move" (5+ distinct wallets buying the same token within a few minutes) and tracked-wallet trades over a threshold Dan sets.
5. Polish: real map data, key-by-mint, mobile performance check (dot count, frame rate), PWA/home-screen icon from the mascot.

## Working style
Dan is non-corporate and moves fast: short plain explanations, say what you changed and how to run it, ask before anything destructive or anything that needs his keys.
