// Probe PumpPortal: connect, subscribe to new tokens, then to trades on the first few mints. Prints everything for 60s.
import WebSocket from "ws";
const ws = new WebSocket("wss://pumpportal.fun/api/data"), counts = {}, mints = [];
let shown = 0;
const send = o => { console.log(">> sent", JSON.stringify(o).slice(0, 160)); ws.send(JSON.stringify(o)); };
ws.on("open", () => { console.log("connected"); send({ method: "subscribeNewToken" }); });
ws.on("message", raw => {
  const s = String(raw); let d; try { d = JSON.parse(s) } catch { console.log("non-JSON:", s.slice(0, 200)); return }
  const k = d.txType || (d.message ? "message" : d.errors ? "errors" : "other"); counts[k] = (counts[k] || 0) + 1;
  if (d.txType === "create") {
    if (mints.length < 20) { mints.push(d.mint); send({ method: "subscribeTokenTrade", keys: [d.mint] }); }
    if (counts.create === 1) console.log("first create msg fields:", Object.keys(d).join(","));
  } else if (shown++ < 12) console.log("<<", s.slice(0, 300));
});
ws.on("close", (c, r) => console.log("closed", c, String(r)));
ws.on("error", e => console.log("error", e.message));
setTimeout(() => { console.log("\nSUMMARY (message types received in 60s):", counts); process.exit(0); }, 60000);
