// Graduation race: tracks bonding-curve progress per token and ranks the runners closest to the finish.
export const FINISH = 0.985;
export function createRace({now = () => Date.now(), activeMs = 600000, doneMs = 180000, histMs = 120000, maxTokens = 5000} = {}) {
  const m = new Map();
  function update(mint, sym, p) {
    if (!(p >= 0)) return;
    const t = now();
    let r = m.get(mint);
    if (!r) { if (m.size >= maxTokens) m.delete(m.keys().next().value); r = { mint, sym: sym || "?", p: 0, t, h: [], done: 0 }; m.set(mint, r) }
    if (sym) r.sym = sym;
    r.p = p; r.t = t;
    r.h.push([t, p]);
    while (r.h.length > 1 && t - r.h[0][0] > histMs) r.h.shift();
    if (p >= FINISH && !r.done) r.done = t || 1;
  }
  function snapshot({ minProg = 0.2, limit = 14 } = {}) {
    const t = now(), out = [];
    for (const r of m.values()) {
      if (r.done ? t - r.done > doneMs : t - r.t > activeMs) { m.delete(r.mint); continue }
      if (r.p < minProg && !r.done) continue;
      const a = r.h[0], dt = (r.t - a[0]) / 60000, v = dt > 0.05 ? (r.p - a[1]) / dt : 0;
      out.push({ m: r.mint, s: r.sym, p: Math.round(r.p * 1000) / 1000, v: Math.round(v * 1000) / 1000, a: Math.round((t - r.t) / 1000), g: r.done ? 1 : 0 });
    }
    out.sort((x, y) => y.g - x.g || y.p - x.p);
    return out.slice(0, limit);
  }
  return { update, snapshot };
}
