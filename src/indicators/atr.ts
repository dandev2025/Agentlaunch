import type { Candle } from '../core/types.js';

/** Incremental Wilder ATR over closed candles. `value` is null until `period` candles have closed. */
export class Atr {
  private prevClose: number | null = null;
  private seed: number[] = [];
  value: number | null = null;

  constructor(private period: number) {}

  update(c: Candle): number | null {
    const tr =
      this.prevClose == null
        ? c.high - c.low
        : Math.max(c.high - c.low, Math.abs(c.high - this.prevClose), Math.abs(c.low - this.prevClose));
    this.prevClose = c.close;
    if (this.value == null) {
      this.seed.push(tr);
      if (this.seed.length >= this.period) {
        this.value = this.seed.reduce((a, b) => a + b, 0) / this.seed.length;
        this.seed = [];
      }
    } else {
      this.value = (this.value * (this.period - 1) + tr) / this.period;
    }
    return this.value;
  }
}
