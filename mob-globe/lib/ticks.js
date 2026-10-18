// Per-token trade tick store: the raw material for the on-chain live chart. Memory is capped by token count, ticks per token and age.
export function createTicks({ max = 1200, mints = 250, ttl = 7200000, now = Date.now } = {}) {
  const m = new Map();
  function rec(mint, p, s, b) {
    if (!mint || !(p > 0) || !Number.isFinite(p) || !(s > 0) || !Number.isFinite(s)) return null;
    const t = now();
    let a = m.get(mint);
    if (a) m.delete(mint);
    else { a = []; if (m.size >= mints) m.delete(m.keys().next().value) }
    m.set(mint, a);
    a.push([t, p, s, b ? 1 : 0]);
    while (a.length > max || (a.length && a[0][0] < t - ttl)) a.shift();
    return a[a.length - 1];
  }
  const hist = (mint, n = 1000) => (m.get(mint) || []).slice(-n);
  return { rec, hist, size: () => m.size };
}
