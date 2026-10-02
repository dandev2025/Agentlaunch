/** Price/qty formatting that keeps useful precision for BTC (~1e5) through SOL (~1e2). */
export function fmtPrice(p: number): string {
  const d = p >= 1000 ? 1 : p >= 100 ? 2 : p >= 1 ? 3 : 5;
  return p.toFixed(d);
}
export const fmtUsd = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0));
export const fmtTime = (ts: number): string => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
