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
| `PIN_PASSCODE` | a passcode only you know (needed to track wallets on the live site; without it tracking is OFF for everyone) |

`PORT` is set by the host. `ALLOWED_ORIGINS` is only needed if another website embeds the globe (the relay's own page is always allowed).

## What protects it
Only the relay's own site can open the WebSocket; 8 connections and 10 messages/10s per IP; 120 HTTP API calls/min per IP;
2 KB message cap; slow clients are skipped; token names are sanitised; logo/metadata links must be public https hosts (no internal addresses); logos are served as raster images only; wallet tracking needs your passcode (6 wrong tries per hour per IP); upstream reconnects back off with jitter; SIGTERM
flushes the database before exiting. Secrets exist only in the host's environment.

## Cost note
Helius and Supabase free tiers are used as-is. The host itself usually costs a few dollars a month for always-on. Check the current price.
