import { TF_MS, type Candle, type Timeframe, type Trade } from '../core/types.js';

/**
 * Builds time candles from trades and tracks per-candle + cumulative delta.
 * Trades must arrive in non-decreasing time order. Empty intervals produce no candle.
 * `cvd` is cumulative since this builder was created (engine start / replay start).
 */
export class CandleBuilder {
  readonly tfMs: number;
  private cur: Candle | null = null;
  private cvd = 0;
  readonly history: Candle[] = [];

  constructor(readonly symbol: string, readonly tf: Timeframe, private maxHistory = 500) {
    this.tfMs = TF_MS[tf];
  }

  get current(): Candle | null {
    return this.cur;
  }

  get cumulativeDelta(): number {
    return this.cvd;
  }

  /** Feed a trade; returns the candle that just closed (if the trade opened a new interval). */
  add(t: Trade): Candle | null {
    const bucket = Math.floor(t.ts / this.tfMs) * this.tfMs;
    let closed: Candle | null = null;
    if (this.cur && bucket > this.cur.ts) {
      closed = this.cur;
      this.history.push(closed);
      if (this.history.length > this.maxHistory) this.history.shift();
      this.cur = null;
    }
    // Late trades (bucket < current) are folded into the current candle rather than dropped.
    if (!this.cur) {
      this.cur = {
        symbol: this.symbol, tf: this.tf, ts: bucket,
        open: t.price, high: t.price, low: t.price, close: t.price,
        volume: 0, buyVolume: 0, sellVolume: 0, delta: 0, cvd: this.cvd, trades: 0,
      };
    }
    const c = this.cur;
    c.high = Math.max(c.high, t.price);
    c.low = Math.min(c.low, t.price);
    c.close = t.price;
    c.volume += t.size;
    if (t.side === 'buy') {
      c.buyVolume += t.size;
      c.delta += t.size;
      this.cvd += t.size;
    } else {
      c.sellVolume += t.size;
      c.delta -= t.size;
      this.cvd -= t.size;
    }
    c.cvd = this.cvd;
    c.trades++;
    return closed;
  }
}
