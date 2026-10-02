import type { Config } from '../config/types.js';
import type { GexSnapshot, GexSource, GexView } from '../core/types.js';
import type { Store } from '../db/store.js';

/** Replays stored GEX snapshots: at time t, the latest snapshot taken at or before t (the engine applies maxAge). */
export class GexTimeline implements GexSource {
  private byCurrency = new Map<string, GexSnapshot[]>();

  constructor(private underlyings: Record<string, string>, snapshots: GexSnapshot[]) {
    for (const s of [...snapshots].sort((a, b) => a.ts - b.ts)) {
      const l = this.byCurrency.get(s.underlying) ?? [];
      l.push(s);
      this.byCurrency.set(s.underlying, l);
    }
  }

  static fromStore(store: Store, cfg: Config, fromTs: number, toTs: number): GexTimeline {
    const currencies = [...new Set(Object.values(cfg.gex.underlyings))];
    const snaps = store.loadGexSnapshots(currencies, fromTs, toTs);
    for (const c of currencies) {
      const before = store.latestGexBefore(c, fromTs - 1);
      if (before) snaps.push(before); // the snapshot that was current when the window opens
    }
    return new GexTimeline(cfg.gex.underlyings, snaps);
  }

  get size(): number {
    let n = 0;
    for (const l of this.byCurrency.values()) n += l.length;
    return n;
  }

  gexFor(symbol: string, ts: number): GexView | null {
    const cur = this.underlyings[symbol];
    const list = cur ? this.byCurrency.get(cur) : undefined;
    if (!list?.length || list[0].ts > ts) return null;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid].ts <= ts) lo = mid; else hi = mid - 1;
    }
    const s = list[lo];
    return { underlying: s.underlying, ts: s.ts, spot: s.spot, flipLevel: s.flipLevel, totalGex: s.totalGex };
  }
}
