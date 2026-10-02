/** Heat-map rasterisation: order-book snapshots -> a coarse time x price grid of resting size (pure, tested). */
export interface BookSnap {
  ts: number;
  bids: [number, number][];
  asks: [number, number][];
}

export interface HeatGrid {
  cols: number;
  rows: number;
  fromTs: number;
  toTs: number;
  pMin: number;
  pMax: number;
  /** row 0 = highest price. Values 0..255, scaled against `scale` (quantity at ~full intensity). */
  bid: number[];
  ask: number[];
  scale: number;
}

export function buildHeatGrid(snaps: BookSnap[], o: { fromTs: number; toTs: number; cols: number; rows: number; pMin: number; pMax: number }): HeatGrid {
  const { cols, rows, fromTs, toTs, pMin, pMax } = o;
  const bidQ = new Float64Array(cols * rows), askQ = new Float64Array(cols * rows);
  const span = Math.max(1, toTs - fromTs), pSpan = Math.max(1e-9, pMax - pMin);
  for (const s of snaps) {
    if (s.ts < fromTs || s.ts > toTs) continue;
    const c = Math.min(cols - 1, Math.floor(((s.ts - fromTs) / span) * cols));
    const put = (arr: Float64Array, levels: [number, number][]) => {
      for (const [p, q] of levels) {
        if (p < pMin || p > pMax) continue;
        const r = Math.min(rows - 1, Math.floor(((pMax - p) / pSpan) * rows));
        const i = r * cols + c;
        if (q > arr[i]) arr[i] = q; // a cell shows the biggest resting size seen in it
      }
    };
    put(bidQ, s.bids);
    put(askQ, s.asks);
  }
  // Scale against a high percentile of non-empty cells so a single giant wall doesn't wash everything else out.
  const vals = [...bidQ, ...askQ].filter((v) => v > 0).sort((a, b) => a - b);
  const scale = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.98))] : 1;
  const toBytes = (a: Float64Array) => Array.from(a, (v) => (v <= 0 ? 0 : Math.min(255, Math.max(1, Math.round((v / scale) * 255)))));
  return { cols, rows, fromTs, toTs, pMin, pMax, bid: toBytes(bidQ), ask: toBytes(askQ), scale };
}

/** Compact transport for the client: byte arrays as base64. */
export const toBase64 = (a: number[]): string => Buffer.from(Uint8Array.from(a)).toString('base64');
