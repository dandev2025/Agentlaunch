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
 *  1. buffer diff events, 2. fetch a REST snapshot (lastUpdateId = L), 3. drop events with u < L,
 *  4. the first applied event must satisfy U <= L <= u, 5. every later event must have pu == the previous event's u.
 * Any violation (or a stream reconnect) triggers a fresh snapshot.
 *
 * Note the first event after a snapshot has pu < L (it started before the snapshot) — the pu chain only applies from the
 * second event on. Snapshot downloads are throttled (min interval between fetches, exponential backoff after failures)
 * so a misbehaving feed can never hammer Binance's rate limit.
 */
export class OrderBookSync {
  readonly book = new LocalOrderBook();
  state: 'init' | 'syncing' | 'live' = 'init';
  resyncs = 0;
  private buffer: DepthDiff[] = [];
  private lastU = 0;
  private snapId = 0;
  private awaitingFirst = false;
  private blockedUntil = 0;
  private lastFetchAt = -Infinity;
  private failures = 0;
  private lastLogAt = -Infinity;

  constructor(
    readonly symbol: string,
    private fetchSnapshot: () => Promise<DepthSnapshot>,
    private o: {
      now?: () => number;
      /** Base wait after a failed sync; doubles per consecutive failure, capped at 60s. */
      retryDelayMs?: number;
      /** Minimum time between snapshot downloads for this symbol. */
      minResyncIntervalMs?: number;
      onDesync?: () => void;
      log?: (m: string) => void;
    } = {},
  ) {}

  private now = () => (this.o.now ?? Date.now)();

  private log(m: string): void {
    const t = this.now();
    if (t - this.lastLogAt < 10_000) return; // don't flood the console if something is persistently wrong
    this.lastLogAt = t;
    this.o.log?.(m);
  }

  onDiff(d: DepthDiff): void {
    if (this.state === 'live') {
      const r = this.applyLive(d);
      if (r === 'gap') {
        this.log(`${this.symbol} depth gap (event ${d.U}..${d.u} pu ${d.pu}, expected pu ${this.lastU}) — resyncing`);
        this.desync();
        this.buffer.push(d);
        this.maybeResync();
      }
      return;
    }
    if (this.buffer.length < 20_000) this.buffer.push(d);
    if (this.state === 'init') this.maybeResync();
  }

  /** Apply one event to a live book. 'stale' events (older than the snapshot) are ignored; a 'gap' means events were missed. */
  private applyLive(d: DepthDiff): 'ok' | 'stale' | 'gap' {
    if (this.awaitingFirst) {
      if (d.u < this.snapId) return 'stale';
      if (d.U > this.snapId) return 'gap'; // we missed events between the snapshot and this one
      this.awaitingFirst = false; // U <= L <= u: the first event that spans the snapshot
    } else if (d.pu !== this.lastU) {
      return 'gap';
    }
    this.book.apply(d);
    this.lastU = d.u;
    return 'ok';
  }

  private maybeResync(): void {
    const earliest = Math.max(this.blockedUntil, this.lastFetchAt + (this.o.minResyncIntervalMs ?? 5000));
    if (this.now() >= earliest) void this.resync();
  }

  /** Call when the underlying stream reconnects: whatever we missed makes the book untrustworthy. */
  reset(): void {
    this.desync();
    this.buffer = [];
  }

  private desync(): void {
    const was = this.state === 'live';
    this.state = 'init';
    this.awaitingFirst = false;
    if (was) this.o.onDesync?.();
  }

  async resync(): Promise<void> {
    if (this.state === 'syncing') return;
    this.state = 'syncing';
    this.resyncs++;
    this.lastFetchAt = this.now();
    try {
      const snap = await this.fetchSnapshot();
      this.book.load(snap);
      this.snapId = snap.lastUpdateId;
      this.lastU = snap.lastUpdateId;
      this.awaitingFirst = true;
      const pending = this.buffer;
      this.buffer = [];
      for (const e of pending) {
        if (this.applyLive(e) === 'gap') throw new Error(`buffered event ${e.U}..${e.u} (pu ${e.pu}) does not follow snapshot ${snap.lastUpdateId}`);
      }
      this.state = 'live';
      this.failures = 0;
    } catch (err) {
      this.log(`${this.symbol} order book sync failed: ${(err as Error).message}`);
      this.state = 'init';
      this.awaitingFirst = false;
      this.buffer = [];
      this.failures++;
      this.blockedUntil = this.now() + Math.min(60_000, (this.o.retryDelayMs ?? 5000) * 2 ** (this.failures - 1));
    }
  }
}
