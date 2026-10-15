// Find currently-active pump.fun tokens from candidate public endpoints, subscribe to them on PumpPortal, count trades for 40s.
import WebSocket from "ws";
const U = "https://frontend-api-v3.pump.fun";
const cands = [
  ["pump last_trade", `${U}/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false`],
  ["pump market_cap", `${U}/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false`],
  ["pump currently-live", `${U}/coins/currently-live?limit=50&offset=0&includeNsfw=false`],
  ["gecko trending", "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1"],
  ["dexscreener boosts", "https://api.dexscreener.com/token-boosts/top/v1"],
];
const pool = new Map();
for (const [name, url] of cands) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    const t = await r.text(); let j; try { j = JSON.parse(t) } catch {}
    const arr = Array.isArray(j) ? j : j?.data || j?.coins || [];
    const mints = (Array.isArray(arr) ? arr : []).map(x => x.mint || x.tokenAddress || x.attributes?.address).filter(Boolean);
    console.log(`${name}: HTTP ${r.status}, ${mints.length} mints${mints.length ? "" : " | body: " + t.slice(0, 120)}`);
    mints.filter(m => /pump$/.test(m)).forEach(m => pool.set(m, name));
    if (name.startsWith("pump")) mints.forEach(m => pool.set(m, name));
  } catch (e) { console.log(`${name}: FAILED ${e.message}`) }
}
const list = [...pool.keys()].slice(0, 80);
console.log("subscribing to", list.length, "tokens");
const ws = new WebSocket("wss://pumpportal.fun/api/data"), c = { buy: 0, sell: 0, other: 0 }; const by = {};
ws.on("open", () => ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: list })));
ws.on("message", raw => { let d; try { d = JSON.parse(raw) } catch { return } if (d.txType === "buy" || d.txType === "sell") { c[d.txType]++; const s = pool.get(d.mint); by[s] = (by[s] || 0) + 1; if (c.buy + c.sell === 1) console.log("sample trade:", JSON.stringify(d).slice(0, 300)) } else c.other++ });
setTimeout(() => { console.log("\nRESULT in 40s:", c, "by source:", by); process.exit(0) }, 40000);
