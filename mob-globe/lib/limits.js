// Small guards for running the relay on the public internet.
// Browsers always send Origin on WebSocket upgrades. Same-site pages are allowed automatically; extra sites go in ALLOWED_ORIGINS.
export function originAllowed(origin, host, allowed = []) {
  if (!origin) return true; // non-browser clients (health checks, curl) send none
  try { const u = new URL(origin); return u.host === host || allowed.includes(origin) || allowed.includes(u.host); } catch { return false; }
}
// Client IP: the FIRST X-Forwarded-For entry (the visitor). The last entry is the platform's own proxy and would be
// shared by everybody, so per-visitor limits would hit all visitors at once. A forged value only lets someone dodge their own
// per-IP limit, so there is also a global connection cap in the relay.
export function clientIp(req, trustProxy = true) {
  const xff = trustProxy && req.headers["x-forwarded-for"];
  if (xff) { const p = String(xff).split(",").map(s => s.trim()).filter(Boolean); if (p.length) return p[0]; }
  return req.socket?.remoteAddress || "unknown";
}
// Fixed-window counter: hit(key) is false once a key exceeds max within windowMs.
export function createRateLimit({ max, windowMs, now = Date.now }) {
  const m = new Map();
  return { hit(key) {
    const t = now(); let e = m.get(key);
    if (!e || t - e.t >= windowMs) { e = { t, n: 0 }; m.set(key, e); if (m.size > 20000) m.delete(m.keys().next().value); }
    return ++e.n <= max;
  } };
}
// Caps concurrent connections per key. acquire() returns a release function, or null when full.
export function createConnLimit(max) {
  const m = new Map();
  return { acquire(key) {
    const n = m.get(key) || 0; if (n >= max) return null; m.set(key, n + 1); let done = false;
    return () => { if (done) return; done = true; const k = (m.get(key) || 1) - 1; k ? m.set(key, k) : m.delete(key); };
  }, count: key => m.get(key) || 0 };
}
// Reconnect delay: 1s, 2s, 4s ... capped at 30s, with jitter so restarts don't stampede.
export const backoff = (n, rnd = Math.random) => Math.min(30000, 1000 * 2 ** n) * (0.5 + rnd() / 2);
// Token names come from third parties and are rendered into the page: keep letters, digits and . _ - only.
export const cleanSym = (s, mint = "") => {
  const body = String(s ?? "").replace(/^\$+/, "").replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 14);
  return "$" + (body || String(mint).slice(0, 4) || "?").toUpperCase();
};
// Logo/metadata links are chosen by token creators. Only fetch public https hosts (no IPs, localhost or internal names).
export function safeUrl(u) {
  try {
    const x = new URL(u); const h = x.hostname.toLowerCase();
    if (x.protocol !== "https:" || x.port && x.port !== "443" || x.username || x.password) return false;
    if (/^[\d.]+$/.test(h) || h.includes(":") || h === "localhost" || !h.includes(".")) return false;
    return !/\.(local|internal|lan|home|localdomain|corp)$/.test(h);
  } catch { return false; }
}
