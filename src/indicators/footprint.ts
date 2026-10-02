import type { FootprintCandle, FootprintEvent, FootprintLevel, Timeframe, Trade } from '../core/types.js';
import { TF_MS } from '../core/types.js';

export interface FootprintOptions {
  imbalanceRatio: number;
  stackedMin: number;
  /** A level only counts as imbalanced if its dominant volume >= this fraction of the candle's total volume. */
  minVolFrac: number;
  absorption: {
    zoneFrac: number;
    minZoneShare: number;
    dominanceRatio: number;
    rejectFrac: number;
    volMult: number;
    volLookback: number;
    minLevels: number;
  };
}

/** Builds footprint candles (bid/ask volume per price bin) from trades in time order. */
export class FootprintBuilder {
  private tfMs: number;
  private ts = -1;
  private bins = new Map<number, FootprintLevel>();
  private o = 0; private h = 0; private l = 0; private c = 0;

  constructor(readonly symbol: string, readonly tf: Timeframe, readonly binSize: number) {
    this.tfMs = TF_MS[tf];
  }

  /** Feed a trade; returns the footprint candle that just closed, if any. */
  add(t: Trade): FootprintCandle | null {
    const bucket = Math.floor(t.ts / this.tfMs) * this.tfMs;
    let closed: FootprintCandle | null = null;
    if (this.ts >= 0 && bucket > this.ts) {
      closed = this.finish();
      this.bins = new Map();
      this.ts = -1;
    }
    if (this.ts < 0) {
      this.ts = bucket;
      this.o = this.h = this.l = t.price;
    }
    this.h = Math.max(this.h, t.price);
    this.l = Math.min(this.l, t.price);
    this.c = t.price;
    const bin = Math.round(t.price / this.binSize);
    let lv = this.bins.get(bin);
    if (!lv) this.bins.set(bin, (lv = { price: bin * this.binSize, bid: 0, ask: 0, trades: 0 }));
    if (t.side === 'buy') lv.ask += t.size;
    else lv.bid += t.size;
    lv.trades++;
    return closed;
  }

  private finish(): FootprintCandle {
    let min = Infinity, max = -Infinity;
    for (const b of this.bins.keys()) { if (b < min) min = b; if (b > max) max = b; }
    const levels: FootprintLevel[] = [];
    let totalBid = 0, totalAsk = 0;
    for (let b = min; b <= max; b++) {
      const lv = this.bins.get(b) ?? { price: b * this.binSize, bid: 0, ask: 0, trades: 0 };
      levels.push(lv);
      totalBid += lv.bid;
      totalAsk += lv.ask;
    }
    return {
      symbol: this.symbol, tf: this.tf, ts: this.ts, open: this.o, high: this.h, low: this.l, close: this.c,
      binSize: this.binSize, levels, totalBid, totalAsk,
    };
  }
}

export interface ImbalanceMark {
  index: number;
  side: 'buy' | 'sell';
}

/**
 * Diagonal imbalances (the usual footprint convention):
 *  - buy imbalance at level i:  ask[i]  >= ratio x bid[i-1]   (buyers at this price vs sellers one level below)
 *  - sell imbalance at level i: bid[i]  >= ratio x ask[i+1]   (sellers at this price vs buyers one level above)
 * The bottom level has no buy comparison and the top level has no sell comparison, so they are skipped.
 */
export function imbalanceMarks(fc: FootprintCandle, o: Pick<FootprintOptions, 'imbalanceRatio' | 'minVolFrac'>): ImbalanceMark[] {
  const total = fc.totalAsk + fc.totalBid;
  const minVol = o.minVolFrac * total;
  const L = fc.levels;
  const marks: ImbalanceMark[] = [];
  for (let i = 0; i < L.length; i++) {
    if (i > 0 && L[i].ask >= minVol && L[i].ask > 0 && L[i].ask >= o.imbalanceRatio * L[i - 1].bid) marks.push({ index: i, side: 'buy' });
    if (i < L.length - 1 && L[i].bid >= minVol && L[i].bid > 0 && L[i].bid >= o.imbalanceRatio * L[i + 1].ask) marks.push({ index: i, side: 'sell' });
  }
  return marks;
}

/** Runs of >= stackedMin consecutive same-side imbalances. */
export function detectStackedImbalance(fc: FootprintCandle, o: FootprintOptions): FootprintEvent[] {
  const marks = imbalanceMarks(fc, o);
  const out: FootprintEvent[] = [];
  for (const side of ['buy', 'sell'] as const) {
    const idx = marks.filter((m) => m.side === side).map((m) => m.index).sort((a, b) => a - b);
    let run: number[] = [];
    const flush = () => {
      if (run.length >= o.stackedMin) {
        const lv = run.map((i) => fc.levels[i]);
        const vol = lv.reduce((a, l) => a + (side === 'buy' ? l.ask : l.bid), 0);
        out.push({
          kind: 'stacked_imbalance', direction: side === 'buy' ? 'LONG' : 'SHORT',
          symbol: fc.symbol, tf: fc.tf, ts: fc.ts, lo: lv[0].price, hi: lv[lv.length - 1].price,
          detail: { side, levels: run.length, dominantVolume: vol, ratio: o.imbalanceRatio, shareOfCandle: vol / (fc.totalAsk + fc.totalBid) },
        });
      }
      run = [];
    };
    for (const i of idx) {
      if (run.length && i !== run[run.length - 1] + 1) flush();
      run.push(i);
    }
    flush();
  }
  return out;
}

/**
 * Absorption: heavy aggressive flow at an extreme that fails to push price further.
 *  - sell absorption (bullish): aggressive SELLING dominates the bottom zone, volume is elevated, and price closes back up
 *  - buy absorption (bearish): aggressive BUYING dominates the top zone, volume is elevated, and price closes back down
 * `avgVolume` is the recent average candle volume for this timeframe; null (not warm yet) disables detection.
 */
export function detectAbsorption(fc: FootprintCandle, avgVolume: number | null, o: FootprintOptions): FootprintEvent[] {
  const a = o.absorption;
  const total = fc.totalAsk + fc.totalBid;
  const range = fc.high - fc.low;
  if (avgVolume == null || avgVolume <= 0 || fc.levels.length < a.minLevels || range <= 0 || total < a.volMult * avgVolume) return [];

  const out: FootprintEvent[] = [];
  const zoneOf = (low: boolean) => {
    const lv = fc.levels.filter((l) => (low ? l.price <= fc.low + a.zoneFrac * range : l.price >= fc.high - a.zoneFrac * range));
    return { lv, bid: lv.reduce((s, l) => s + l.bid, 0), ask: lv.reduce((s, l) => s + l.ask, 0) };
  };

  const bottom = zoneOf(true);
  if (bottom.lv.length && bottom.bid / total >= a.minZoneShare && bottom.bid >= a.dominanceRatio * bottom.ask && (fc.close - fc.low) / range >= a.rejectFrac) {
    out.push({
      kind: 'absorption', direction: 'LONG', symbol: fc.symbol, tf: fc.tf, ts: fc.ts,
      lo: bottom.lv[0].price, hi: bottom.lv[bottom.lv.length - 1].price,
      detail: { type: 'sell_absorption', zoneSellVolume: bottom.bid, zoneBuyVolume: bottom.ask, zoneShare: bottom.bid / total, volumeVsAvg: total / avgVolume, closeInRange: (fc.close - fc.low) / range },
    });
  }
  const top = zoneOf(false);
  if (top.lv.length && top.ask / total >= a.minZoneShare && top.ask >= a.dominanceRatio * top.bid && (fc.high - fc.close) / range >= a.rejectFrac) {
    out.push({
      kind: 'absorption', direction: 'SHORT', symbol: fc.symbol, tf: fc.tf, ts: fc.ts,
      lo: top.lv[0].price, hi: top.lv[top.lv.length - 1].price,
      detail: { type: 'buy_absorption', zoneBuyVolume: top.ask, zoneSellVolume: top.bid, zoneShare: top.ask / total, volumeVsAvg: total / avgVolume, closeFromHigh: (fc.high - fc.close) / range },
    });
  }
  return out;
}
