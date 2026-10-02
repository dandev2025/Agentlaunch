import type { Store, WallRow } from '../db/store.js';
import type { WallSource, WallView } from '../core/types.js';

interface Timeline {
  row: WallRow;
  endTs: number;
  /** size samples: [ts, size] ascending (added + changed events) */
  sizes: [number, number][];
}

/**
 * Rebuilds "which walls were standing at time t, and how big" from the stored wall lifecycle
 * (book_walls + book_wall_events), so heat-map conditions can be backtested. Size is only known at
 * event granularity (added / changed >= changeFrac), and `executed` is not reconstructed (reported 0).
 */
export class WallTimeline implements WallSource {
  private bySymbol = new Map<string, Timeline[]>();

  constructor(rows: WallRow[], events: { wallId: number; ts: number; type: string; size: number }[]) {
    const evBy = new Map<number, typeof events>();
    for (const e of events) evBy.set(e.wallId, [...(evBy.get(e.wallId) ?? []), e]);
    for (const row of rows) {
      const sizes: [number, number][] = [[row.firstSeen, row.peak]];
      const evs = evBy.get(row.id) ?? [];
      for (const e of evs) {
        if (e.type === 'added') sizes[0] = [e.ts, e.size];
        else if (e.type === 'changed') sizes.push([e.ts, e.size]);
      }
      const list = this.bySymbol.get(row.symbol) ?? [];
      list.push({ row, endTs: row.status === 'active' ? Infinity : row.lastSeen, sizes });
      this.bySymbol.set(row.symbol, list);
    }
  }

  static fromStore(store: Store, symbols: string[], fromTs: number, toTs: number): WallTimeline {
    const rows = store.loadWalls(symbols, fromTs, toTs);
    return new WallTimeline(rows, store.loadWallEvents(rows.map((r) => r.id)));
  }

  get size(): number {
    let n = 0;
    for (const l of this.bySymbol.values()) n += l.length;
    return n;
  }

  activeWalls(symbol: string, ts: number): WallView[] {
    const out: WallView[] = [];
    for (const t of this.bySymbol.get(symbol) ?? []) {
      if (t.row.firstSeen > ts) break; // rows are ordered by first_seen
      if (ts >= t.endTs) continue;
      let size = t.sizes[0][1], peak = size;
      for (const [sts, s] of t.sizes) {
        if (sts > ts) break;
        size = s;
        if (s > peak) peak = s;
      }
      out.push({ id: t.row.id, side: t.row.side, price: t.row.price, size, peak, firstSeen: t.row.firstSeen, executed: 0 });
    }
    return out;
  }
}
