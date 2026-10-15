# Deploying the Mob Globe relay

The relay is one Node process (`npm start`) that serves the page and the live WebSocket. Any host that runs Node 20.6+ and
keeps a process alive works (Railway, Render, Fly). Free tiers that sleep when idle will NOT work: the feed would stop.

## Settings (same on any host)
- Repo: `dandev2025/agentlaunch`, branch `claude/tender-cori-z7vkrs` (or main once merged)
- **Root directory:** `mob-globe`
- Build command: `npm install`  |  Start command: `npm start`
- Health check path: `/healthz` (returns 503 if the feeds stall, so the host can restart it)
- Environment variables (enter in the host's dashboard, never in the repo):

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `HELIUS_KEY` | your Helius key |
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | your secret key |
| `DECODE_PER_SEC` | `0.4` (free Helius plan) |
| `LAUNCH_DATE` | your official start, e.g. `2026-10-16T00:00:00Z`. Nothing is counted before it. Leave unset to count from the first saved trade |
| `DEX_FEEDS` | leave UNSET. Setting it to `1` also listens to Jupiter/Raydium/Orca/Meteora, which streams about 1 MB/s and uses roughly 1.7M Helius credits a day |
| `FEED_MODE` | `manual` (default): the Helius feed is OFF until the owner presses Go live (open the site with `?owner`, e.g. https://yoursite/?owner). A session lasts `SESSION_MIN` minutes (default 30) and ends early 60s after the last viewer leaves. `ondemand`: starts when anyone opens the page. `always`: runs 24/7 (needs a paid Helius plan). Totals only count while the feed runs |
| `PIN_PASSCODE` | a passcode only you know (needed to track wallets on the live site; without it tracking is OFF for everyone) |

`PORT` is set by the host. `ALLOWED_ORIGINS` is only needed if another website embeds the globe (the relay's own page is always allowed).

## What protects it
Only the relay's own site can open the WebSocket; 8 connections and 10 messages/10s per IP; 120 HTTP API calls/min per IP;
2 KB message cap; slow clients are skipped; token names are sanitised; logo/metadata links must be public https hosts (no internal addresses); logos are served as raster images only; wallet tracking needs your passcode (6 wrong tries per hour per IP); upstream reconnects back off with jitter; SIGTERM
flushes the database before exiting. Secrets exist only in the host's environment.

## Cost note
Render (checked on render.com/pricing, 15 Oct 2026): Hobby workspace $0 + an always-on instance at $7/month (0.5 CPU, 512 MB). Free instances sleep, so don't use them.
Bandwidth: 5 GB/month included, then $0.15/GB. Each open viewer is capped at about 8 trades/s (`SEND_PER_SEC`), roughly 200 MB per day per tab left open all day. Big trades ($2k+) and tracked wallets are never dropped.
Helius and Supabase free tiers are used as-is. The host itself usually costs a few dollars a month for always-on. Check the current price.

## Fly.io (cheapest always-on option)
Files are ready: `Dockerfile`, `fly.toml`. Run these in Terminal inside the `mob-globe` folder (needs a Fly account with a card):
```
brew install flyctl          # or see fly.io/docs/flyctl/install
fly auth login
# edit fly.toml: change app = "mob-globe-CHANGE-ME" to a unique name
fly launch --no-deploy --copy-config --name YOUR-UNIQUE-NAME
# load secrets straight from your .env without printing them (add PIN_PASSCODE and LAUNCH_DATE to .env first):
grep -E '^(HELIUS_KEY|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|DECODE_PER_SEC|PIN_PASSCODE|LAUNCH_DATE)=' .env | fly secrets import
fly deploy
fly status
curl https://YOUR-UNIQUE-NAME.fly.dev/healthz
```
Keep exactly ONE machine running (`fly scale count 1`): two copies would double-count trades.

## Helius credits (read this)
Helius meters live websocket data at 2 credits per 0.1 MB (checked on helius.dev/docs, 15 Oct 2026). Free = 1M credits/month, Developer ($49/mo) = 10M.
The pump.fun-only feed is roughly 100 KB/s, about 5-6M credits a month, so it needs the Developer plan. Turning on `DEX_FEEDS=1` multiplies that by about 8 and will drain even the Developer plan in days.
When credits run out Helius answers "max usage reached" and the live feed goes silent. Set a usage alert in the Helius dashboard.
