export type RawLevel = [string, string];

export interface DepthDiff {
  U: number; // first update id in event
  u: number; // final update id in event
  pu: number; // final update id of the previous event
  b: RawLevel[];
  a: RawLevel[];
}

export interface DepthSnapshot {
  lastUpdateId: number;
  bids: RawLevel[];
  asks: RawLevel[];
}

export interface AggregatedBook {
  binSize: number;
  mid: number;
  /** bin index -> total resting quantity. Price of a bin = index x binSize. */
  bids: Map<number, number>;
  asks: Map<number, number>;
  minBin: number;
  maxBin: number;
}

export class LocalOrderBook {
  bids = new Map<number, number>();
  asks = new Map<number, number>();
  lastUpdateId = 0;

  load(s: DepthSnapshot): void {
    this.bids.clear();
    this.asks.clear();
    this.applyLevels(this.bids, s.bids);
    this.applyLevels(this.asks, s.asks);
    this.lastUpdateId = s.lastUpdateId;
  }

  apply(d: DepthDiff): void {
    this.applyLevels(this.bids, d.b);
    this.applyLevels(this.asks, d.a);
    this.lastUpdateId = d.u;
  }

  private applyLevels(side: Map<number, number>, levels: RawLevel[]): void {
    for (const [p, q] of levels) {
      const price = Number(p), qty = Number(q);
      if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
      if (qty === 0) side.delete(price);
      else side.set(price, qty);
    }
  }

  best(): { bid: number; ask: number } | null {
    let bid = -Infinity, ask = Infinity;
    for (const p of this.bids.keys()) if (p > bid) bid = p;
    for (const p of this.asks.keys()) if (p < ask) ask = p;
    return Number.isFinite(bid) && Number.isFinite(ask) ? { bid, ask } : null;
  }

  /** Aggregate to `binSize` bins within ±rangePct of the mid price. Returns null for an empty/crossed book. */
  aggregate(binSize: number, rangePct: number): AggregatedBook | null {
    const b = this.best();
    if (!b || b.bid >= b.ask) return null;
    const mid = (b.bid + b.ask) / 2;
    const lo = mid * (1 - rangePct), hi = mid * (1 + rangePct);
    const bids = new Map<number, number>(), asks = new Map<number, number>();
    for (const [p, q] of this.bids) if (p >= lo) { const k = Math.round(p / binSize); bids.set(k, (bids.get(k) ?? 0) + q); }
    for (const [p, q] of this.asks) if (p <= hi) { const k = Math.round(p / binSize); asks.set(k, (asks.get(k) ?? 0) + q); }
    return { binSize, mid, bids, asks, minBin: Math.round(lo / binSize), maxBin: Math.round(hi / binSize) };
  }
}

/**
 * Keeps a LocalOrderBook in sync using Binance's documented procedure for the futures diff stream:
 *  1. buffer diff events, 2. fetch a REST snapshot, 3. drop events with u < lastUpdateId,
 *  4. the first applied event must satisfy U <= lastUpdateId <= u, 5. every later event must have
 *  pu == previous event's u. Any violation (or a stream reconnect) triggers a fresh snapshot.
 */
export class OrderBookSync {
  readonly book = new LocalOrderBook();
  state: 'init' | 'syncing' | 'live' = 'init';
  resyncs = 0;
  private buffer: DepthDiff[] = [];
  private lastU = 0;
  private blockedUntil = 0;

  constructor(
    readonly symbol: string,
    private fetchSnapshot: () => Promise<DepthSnapshot>,
    private o: { now?: () => number; retryDelayMs?: number; onDesync?: () => void; log?: (m: string) => void } = {},
  ) {}

  private now = () => (this.o.now ?? Date.now)();

  onDiff(d: DepthDiff): void {
    if (this.state === 'live') {
      if (d.pu !== this.lastU) {
        this.o.log?.(`${this.symbol} depth gap (pu ${d.pu} != ${this.lastU}) — resyncing`);
        this.desync();
        this.buffer.push(d);
        void this.resync();
        return;
      }
      this.book.apply(d);
      this.lastU = d.u;
      return;
    }
    if (this.buffer.length < 20_000) this.buffer.push(d);
    if (this.state === 'init' && this.now() >= this.blockedUntil) void this.resync();
  }

  /** Call when the underlying stream reconnects: whatever we missed makes the book untrustworthy. */
  reset(): void {
    this.desync();
    this.buffer = [];
  }

  private desync(): void {
    const was = this.state === 'live';
    this.state = 'init';
    if (was) this.o.onDesync?.();
  }

  async resync(): Promise<void> {
    if (this.state === 'syncing') return;
    this.state = 'syncing';
    this.resyncs++;
    try {
      const snap = await this.fetchSnapshot();
      this.book.load(snap);
      const lid = snap.lastUpdateId;
      const events = this.buffer.filter((e) => e.u >= lid);
      this.buffer = [];
      let prevU = -1;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (i === 0 && !(e.U <= lid && e.u >= lid)) throw new Error(`first event ${e.U}..${e.u} does not cover snapshot ${lid}`);
        if (i > 0 && e.pu !== prevU) throw new Error(`event chain broken at ${e.U} (pu ${e.pu} != ${prevU})`);
        this.book.apply(e);
        prevU = e.u;
      }
      this.lastU = events.length ? prevU : lid;
      this.state = 'live';
    } catch (err) {
      this.o.log?.(`${this.symbol} order book sync failed: ${(err as Error).message}`);
      this.state = 'init';
      this.buffer = [];
      this.blockedUntil = this.now() + (this.o.retryDelayMs ?? 5000);
    }
  }
}
