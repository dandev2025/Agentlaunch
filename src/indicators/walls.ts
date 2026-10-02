import type { AggregatedBook } from '../collector/orderbook.js';
import type { Trade, WallEvent, WallEventType, WallSide, WallView } from '../core/types.js';

export interface WallOptions {
  minQty: number;
  relMult: number;
  dropFrac: number;
  eatenFrac: number;
  changeFrac: number;
}

interface Wall extends WallView {
  bin: number;
  binSize: number;
  lastRecorded: number;
  swept: boolean;
}

/**
 * Tracks large resting levels over successive aggregated-book updates and classifies how they end:
 *  - added:   level newly >= threshold, threshold = max(minQty, relMult x median level size)
 *  - changed: size moved by >= changeFrac since the last recorded size
 *  - eaten:   wall ended (size < dropFrac x peak) AND aggressive trades hit it (>= eatenFrac x peak) or price swept through
 *  - pulled:  wall ended without that execution — the liquidity was cancelled, not traded into
 *  - expired: tracking stopped (left the tracked range, or the book desynced) — says nothing about intent
 * Resolution is the update interval, so a pull right before a sweep can be mislabelled "eaten".
 */
export class WallTracker {
  private walls = new Map<string, Wall>();
  private nextId = 1;

  constructor(readonly symbol: string, private o: WallOptions) {}

  active(): WallView[] {
    return [...this.walls.values()].map((w) => this.view(w));
  }

  private view(w: Wall): WallView {
    return { id: w.id, side: w.side, price: w.price, size: w.size, peak: w.peak, firstSeen: w.firstSeen, executed: w.executed };
  }

  onTrade(t: Trade): void {
    for (const w of this.walls.values()) {
      const tb = Math.round(t.price / w.binSize);
      if (w.side === 'bid' && t.side === 'sell') {
        if (tb === w.bin) w.executed += t.size;
        else if (tb < w.bin) w.swept = true;
      } else if (w.side === 'ask' && t.side === 'buy') {
        if (tb === w.bin) w.executed += t.size;
        else if (tb > w.bin) w.swept = true;
      }
    }
  }

  update(ts: number, book: AggregatedBook): WallEvent[] {
    const events: WallEvent[] = [];
    const sizes = [...book.bids.values(), ...book.asks.values()].filter((q) => q > 0).sort((a, b) => a - b);
    if (!sizes.length) return events;
    const median = sizes[Math.floor(sizes.length / 2)];
    const threshold = Math.max(this.o.minQty, this.o.relMult * median);

    const emit = (type: WallEventType, w: Wall, extra: Record<string, unknown> = {}) => {
      const lifetimeMs = ts - w.firstSeen;
      events.push({
        type, symbol: this.symbol, ts, wall: this.view(w),
        detail: { lifetimeMs, spoofLike: lifetimeMs < 10_000 && w.executed === 0, threshold, ...extra },
      });
    };

    for (const side of ['bid', 'ask'] as WallSide[]) {
      const levels = side === 'bid' ? book.bids : book.asks;
      // existing walls
      for (const [key, w] of [...this.walls]) {
        if (w.side !== side) continue;
        if (w.bin < book.minBin || w.bin > book.maxBin) {
          this.walls.delete(key);
          emit('expired', w, { reason: 'out_of_range' });
          continue;
        }
        const q = levels.get(w.bin) ?? 0;
        if (q < this.o.dropFrac * w.peak) {
          const eaten = w.swept || w.executed >= this.o.eatenFrac * w.peak;
          w.size = q;
          this.walls.delete(key);
          emit(eaten ? 'eaten' : 'pulled', w, { swept: w.swept });
          continue;
        }
        w.size = q;
        if (q > w.peak) w.peak = q;
        if (Math.abs(q - w.lastRecorded) / w.lastRecorded >= this.o.changeFrac) {
          w.lastRecorded = q;
          emit('changed', w);
        }
      }
      // new walls
      for (const [bin, q] of levels) {
        const key = `${side}:${bin}`;
        if (q < threshold || this.walls.has(key)) continue;
        const w: Wall = {
          id: this.nextId++, side, bin, binSize: book.binSize, price: bin * book.binSize, size: q, peak: q, firstSeen: ts,
          executed: 0, lastRecorded: q, swept: false,
        };
        this.walls.set(key, w);
        emit('added', w);
      }
    }
    return events;
  }

  /** Stop tracking everything (e.g. the book lost sync). */
  expireAll(ts: number): WallEvent[] {
    const out: WallEvent[] = [];
    for (const w of this.walls.values()) {
      const lifetimeMs = ts - w.firstSeen;
      out.push({ type: 'expired', symbol: this.symbol, ts, wall: this.view(w), detail: { lifetimeMs, spoofLike: false, reason: 'desync' } });
    }
    this.walls.clear();
    return out;
  }
}
