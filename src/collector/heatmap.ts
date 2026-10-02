import type { Config } from '../config/types.js';
import type { Trade, WallEvent, WallSource, WallView } from '../core/types.js';
import type { Store } from '../db/store.js';
import { WallTracker } from '../indicators/walls.js';
import { OrderBookSync, type AggregatedBook, type DepthDiff, type DepthSnapshot } from './orderbook.js';
import type { FetchJson } from './gaps.js';

export interface HeatmapOptions {
  fetchJson?: FetchJson;
  now?: () => number;
  log?: (m: string) => void;
}

const defaultFetchJson: FetchJson = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
};

/**
 * Live heat-map service: keeps a local L2 book per symbol (diff stream + REST snapshot), tracks large
 * resting walls on a fixed cadence, persists wall lifecycles and aggregated snapshots, and serves
 * the currently standing walls to the signal engine.
 */
export class HeatmapService implements WallSource {
  readonly syncs = new Map<string, OrderBookSync>();
  private trackers = new Map<string, WallTracker>();
  private dbIds = new Map<string, Map<number, number>>(); // symbol -> local wall id -> db id
  private lastSnapshotAt = new Map<string, number>();
  private lastPruneAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private now: () => number;
  private log: (m: string) => void;
  /** Called for every wall event after it has been persisted. */
  onWallEvent?: (e: WallEvent) => void;

  constructor(private cfg: Config, private store: Store, private o: HeatmapOptions = {}) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[heatmap] ${m}`));
    const fetchJson = o.fetchJson ?? defaultFetchJson;
    const w = cfg.heatmap.wall;
    for (const [sym, a] of Object.entries(cfg.assets)) {
      if (!a.enabled) continue;
      this.trackers.set(sym, new WallTracker(sym, { minQty: a.wallMinQty, relMult: w.relMult, dropFrac: w.dropFrac, eatenFrac: w.eatenFrac, changeFrac: w.changeFrac }));
      this.dbIds.set(sym, new Map());
      this.syncs.set(
        sym,
        new OrderBookSync(
          sym,
          () => fetchJson(`${cfg.collector.restBaseUrl}/fapi/v1/depth?symbol=${sym}&limit=${cfg.collector.depth.snapshotLimit}`) as Promise<DepthSnapshot>,
          { now: this.now, log: this.log, onDesync: () => this.expire(sym) },
        ),
      );
    }
    // Walls left "active" by a previous run are orphaned; close them so replay never sees them as endless.
    store.closeStaleWalls();
  }

  start(): void {
    this.timer = setInterval(() => this.tick(this.now()), this.cfg.heatmap.trackIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const sym of this.trackers.keys()) this.expire(sym);
  }

  onDepth(symbol: string, d: DepthDiff): void {
    this.syncs.get(symbol)?.onDiff(d);
  }

  /** The websocket reconnected: depth events were missed, so every book must be rebuilt. */
  onStreamReconnect(): void {
    for (const s of this.syncs.values()) s.reset();
  }

  onTrade(t: Trade): void {
    this.trackers.get(t.symbol)?.onTrade(t);
  }

  activeWalls(symbol: string, _ts: number): WallView[] {
    return this.syncs.get(symbol)?.state === 'live' ? this.trackers.get(symbol)?.active() ?? [] : [];
  }

  /** One tracking pass for every live book. Public so tests can drive time. */
  tick(now: number): void {
    const hm = this.cfg.heatmap;
    for (const [sym, sync] of this.syncs) {
      if (sync.state !== 'live') continue;
      const a = this.cfg.assets[sym];
      const agg = sync.book.aggregate(a.binSize, hm.rangePct);
      if (!agg) continue;
      for (const e of this.trackers.get(sym)!.update(now, agg)) this.persist(e);
      if (hm.snapshot.persist && now - (this.lastSnapshotAt.get(sym) ?? 0) >= hm.snapshot.intervalMs) {
        this.lastSnapshotAt.set(sym, now);
        this.snapshot(sym, now, agg);
      }
    }
    if (hm.snapshot.persist && now - this.lastPruneAt >= 3_600_000) {
      this.lastPruneAt = now;
      this.store.pruneOrderbookSnapshots(now - hm.snapshot.retentionHours * 3_600_000);
    }
  }

  private snapshot(sym: string, ts: number, agg: AggregatedBook): void {
    const pairs = (m: Map<number, number>, desc: boolean): [number, number][] =>
      [...m].map(([bin, q]) => [+(bin * agg.binSize).toFixed(8), +q.toFixed(4)] as [number, number]).sort((x, y) => (desc ? y[0] - x[0] : x[0] - y[0]));
    try {
      this.store.recordOrderbookSnapshot(sym, ts, pairs(agg.bids, true), pairs(agg.asks, false));
    } catch (e) {
      this.log(`snapshot write failed for ${sym}: ${(e as Error).message}`);
    }
  }

  private expire(sym: string): void {
    const t = this.trackers.get(sym);
    if (!t) return;
    for (const e of t.expireAll(this.now())) this.persist(e);
  }

  private persist(e: WallEvent): void {
    const ids = this.dbIds.get(e.symbol)!;
    const w = e.wall;
    try {
      let dbId = ids.get(w.id);
      if (e.type === 'added') {
        dbId = this.store.insertWall({ symbol: e.symbol, side: w.side, price: w.price, ts: e.ts, size: w.size });
        ids.set(w.id, dbId);
      } else if (dbId === undefined) {
        return;
      } else {
        const ended = e.type === 'pulled' || e.type === 'eaten' || e.type === 'expired';
        this.store.updateWall(dbId, {
          ts: e.ts, size: w.size, peak: w.peak, executed: w.executed,
          status: ended ? e.type : undefined, detail: ended ? e.detail : undefined,
        });
        if (ended) ids.delete(w.id);
      }
      this.store.recordWallEvent(dbId, e.ts, e.type, w.size);
    } catch (err) {
      this.log(`wall persist failed: ${(err as Error).message}`);
    }
    this.onWallEvent?.(e);
  }
}
