import type { Candle, Divergence } from '../core/types.js';

/**
 * Checks the most recently closed candle (last element of `history`) against the previous
 * `lookback` candles.
 *  - bearish: price makes a new high but cumulative delta closes below where it was at the prior high
 *  - bullish: price makes a new low but cumulative delta closes above where it was at the prior low
 */
export function detectDivergence(history: Candle[], lookback: number): Divergence[] {
  if (history.length < lookback + 1) return [];
  const cur = history[history.length - 1];
  const prior = history.slice(history.length - 1 - lookback, history.length - 1);
  const out: Divergence[] = [];

  let hi = prior[0];
  let lo = prior[0];
  for (const c of prior) {
    if (c.high > hi.high) hi = c;
    if (c.low < lo.low) lo = c;
  }
  if (cur.high > hi.high && cur.cvd < hi.cvd) {
    out.push({ symbol: cur.symbol, tf: cur.tf, ts: cur.ts, type: 'bearish', price: cur.high, refPrice: hi.high, cvd: cur.cvd, refCvd: hi.cvd });
  }
  if (cur.low < lo.low && cur.cvd > lo.cvd) {
    out.push({ symbol: cur.symbol, tf: cur.tf, ts: cur.ts, type: 'bullish', price: cur.low, refPrice: lo.low, cvd: cur.cvd, refCvd: lo.cvd });
  }
  return out;
}

export interface DeltaFlip {
  direction: 'LONG' | 'SHORT';
  delta: number;
  prevDelta: number;
  avgAbsDelta: number;
}

/** Candle delta changes sign with meaningful size (>= minMultOfAvg x recent average |delta|). */
export function detectDeltaFlip(history: Candle[], avgLookback: number, minMultOfAvg: number): DeltaFlip | null {
  if (history.length < 3) return null;
  const cur = history[history.length - 1];
  const prev = history[history.length - 2];
  if (cur.delta === 0 || prev.delta === 0 || Math.sign(cur.delta) === Math.sign(prev.delta)) return null;
  const win = history.slice(-avgLookback - 1, -1);
  const avg = win.reduce((a, c) => a + Math.abs(c.delta), 0) / win.length;
  if (Math.abs(cur.delta) < minMultOfAvg * avg) return null;
  return { direction: cur.delta > 0 ? 'LONG' : 'SHORT', delta: cur.delta, prevDelta: prev.delta, avgAbsDelta: avg };
}

/**
 * Higher-timeframe pressure: z-score of the summed delta over the last `n` candles versus the
 * typical |delta| (scaled by sqrt(n)). Returns null until `minHistory` candles exist.
 */
export function htfDeltaZ(history: Candle[], n: number, historyCandles: number, minHistory: number): number | null {
  if (history.length < Math.max(minHistory, n)) return null;
  const win = history.slice(-historyCandles);
  const meanAbs = win.reduce((a, c) => a + Math.abs(c.delta), 0) / win.length;
  if (meanAbs === 0) return null;
  const sum = history.slice(-n).reduce((a, c) => a + c.delta, 0);
  return sum / (meanAbs * Math.sqrt(n));
}
