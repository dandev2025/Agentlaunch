// Per-viewer token filters, applied on the server so a viewer only receives the trades they asked for.
const num = (v, lo, hi) => { if (v == null || v === "") return null; v = +v; return Number.isFinite(v) && v >= lo && v <= hi ? v : null };

export function sanitizeFilter(o) {
  if (!o || typeof o !== "object") return null;
  const f = {
    mcMin: num(o.mcMin, 0, 1e12), mcMax: num(o.mcMax, 0, 1e12),
    lqMin: num(o.lqMin, 0, 1e12), lqMax: num(o.lqMax, 0, 1e12),
    ageMax: num(o.ageMax, 0, 1e6), ageMin: num(o.ageMin, 0, 1e6),
    minUsd: num(o.minUsd, 0, 1e9),
    side: o.side === "buy" || o.side === "sell" ? o.side : null,
    venues: Array.isArray(o.venues) ? o.venues.filter(v => typeof v === "string" && v.length < 20).slice(0, 8) : [],
  };
  const on = Object.values(f).some(v => (Array.isArray(v) ? v.length : v != null));
  return on ? f : null;
}

// ev: {usd, buy, venue, mc (USD|null), lq (USD|null), age (seconds|null)}
export function passes(f, ev) {
  if (!f) return true;
  if (f.side && (ev.buy ? "buy" : "sell") !== f.side) return false;
  if (f.minUsd != null && !(ev.usd >= f.minUsd)) return false;
  if (f.venues.length && !f.venues.includes(ev.venue)) return false;
  if (f.mcMin != null || f.mcMax != null) {
    if (ev.mc == null) return false;
    if (f.mcMin != null && ev.mc < f.mcMin) return false;
    if (f.mcMax != null && ev.mc > f.mcMax) return false;
  }
  if (f.lqMin != null || f.lqMax != null) {
    if (ev.lq == null) return false;
    if (f.lqMin != null && ev.lq < f.lqMin) return false;
    if (f.lqMax != null && ev.lq > f.lqMax) return false;
  }
  if (f.ageMax != null && (ev.age == null || ev.age / 60 > f.ageMax)) return false; // unknown age counts as old
  if (f.ageMin != null && ev.age != null && ev.age / 60 < f.ageMin) return false;
  return true;
}
