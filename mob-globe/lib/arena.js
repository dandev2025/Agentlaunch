// Paper-trading arena leaderboard. Scores come from players' browsers, so this is for fun only and every value is range-checked.
export const START = 500;
export const cleanName = s => String(s ?? "").replace(/[^A-Za-z0-9 _.\-]/g, "").trim().slice(0, 16) || "Anon";
const ID = /^[a-z0-9]{12,40}$/;

export function createArena({ save, now = Date.now, max = 5000 } = {}) {
  const players = new Map(), dirty = new Set();
  function submit(b) {
    if (!b || typeof b.id !== "string" || !ID.test(b.id)) return false;
    const equity = +b.equity, level = +b.level, wins = +b.wins;
    if (!Number.isFinite(equity) || equity < 0 || equity > 1e6) return false;
    if (!Number.isInteger(level) || level < 1 || level > 99) return false;
    if (!Number.isInteger(wins) || wins < 0 || wins > 99999) return false;
    if (!players.has(b.id) && players.size >= max) return false;
    players.set(b.id, { id: b.id, name: cleanName(b.name), equity: +equity.toFixed(4), level, wins, updated: now() });
    dirty.add(b.id);
    return true;
  }
  const top = (n = 20) => [...players.values()].sort((a, b) => b.equity - a.equity).slice(0, n)
    .map(p => ({ name: p.name, equity: p.equity, gain: +((p.equity / START - 1) * 100).toFixed(1), level: p.level, wins: p.wins }));
  function load(rows) {
    for (const r of rows || []) if (r && ID.test(String(r.id)) && Number.isFinite(+r.equity))
      players.set(r.id, { id: r.id, name: cleanName(r.name), equity: +r.equity, level: r.level | 0 || 1, wins: r.wins | 0, updated: now() });
  }
  async function flush() {
    if (!save || !dirty.size) return;
    const rows = [...dirty].slice(0, 200).map(id => players.get(id)).filter(Boolean)
      .map(p => ({ id: p.id, name: p.name, equity: p.equity, level: p.level, wins: p.wins, updated_at: new Date(p.updated).toISOString() }));
    for (const r of rows) dirty.delete(r.id);
    try { await save(rows) } catch { for (const r of rows) dirty.add(r.id) }
  }
  return { submit, top, load, flush, size: () => players.size };
}
