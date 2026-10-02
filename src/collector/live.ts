import type { Config } from '../config/types.js';
import type { Trade } from '../core/types.js';
import type { Store } from '../db/store.js';
import type { Pipeline } from '../engine/pipeline.js';
import { BinanceStream, parseAggTrade, streamUrl, type WsFactory } from './binance.js';
import { fetchAggTradesRange, GapDetector, type FetchJson } from './gaps.js';

export interface LiveOptions {
  wsFactory?: WsFactory;
  fetchJson?: FetchJson;
  log?: (msg: string) => void;
  now?: () => number;
}

/**
 * Live runner: WebSocket -> gap check/backfill -> SQLite (batched) -> Pipeline.
 * Messages are serialised per symbol so backfilled trades are always processed before the
 * live trade that revealed the gap.
 */
export class LiveCollector {
  private stream: BinanceStream;
  private gaps = new GapDetector();
  private chains = new Map<string, Promise<void>>();
  private buffer: Trade[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private log: (m: string) => void;
  private now: () => number;
  depthMessages = 0;
  gapsFound = 0;
  gapsRecovered = 0;

  constructor(private cfg: Config, private store: Store, private pipeline: Pipeline, private o: LiveOptions = {}) {
    this.log = o.log ?? ((m) => console.log(`[collector] ${m}`));
    this.now = o.now ?? Date.now;
    const c = cfg.collector;
    this.stream = new BinanceStream({
      url: streamUrl(c.wsBaseUrl, pipeline.symbols, c.depth),
      pingIntervalMs: c.pingIntervalMs,
      staleAfterMs: c.staleAfterMs,
      reconnectMinDelayMs: c.reconnectMinDelayMs,
      reconnectMaxDelayMs: c.reconnectMaxDelayMs,
      wsFactory: o.wsFactory,
      onStatus: (s, info) => this.log(`ws ${s}${info ? `: ${info}` : ''}`),
      onMessage: (m) => this.onMessage(m),
    });
  }

  /** Re-feed recent stored trades silently so ATR / profile / delta history are warm. */
  warmup(): number {
    const to = this.now();
    const from = to - this.cfg.collector.warmupMinutes * 60_000;
    let n = 0;
    for (const t of this.store.iterTrades(this.pipeline.symbols, from, to)) {
      this.pipeline.onTrade(t, true);
      n++;
    }
    for (const s of this.pipeline.symbols) this.gaps.seed(s, this.store.lastAggId(s));
    this.log(`warm-up: replayed ${n} stored trades`);
    return n;
  }

  start(): void {
    this.flushTimer = setInterval(() => this.flush(), this.cfg.collector.flushIntervalMs);
    this.stream.start();
  }

  async stop(): Promise<void> {
    this.stream.stop();
    if (this.flushTimer) clearInterval(this.flushTimer);
    await Promise.all(this.chains.values());
    this.flush();
    this.pipeline.flush();
  }

  get connected(): boolean {
    return this.stream.connected;
  }

  get lastFrameAt(): number {
    return this.stream.lastFrameAt;
  }

  get reconnects(): number {
    return this.stream.reconnects;
  }

  flush(): void {
    if (!this.buffer.length) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      this.store.insertTrades(batch);
    } catch (e) {
      this.log(`DB write failed (${batch.length} trades): ${(e as Error).message}`);
    }
  }

  /** Test hook: resolves when all queued messages have been processed. */
  async idle(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  private onMessage(m: { stream: string; data: any }): void {
    if (m.stream.includes('@depth')) {
      this.depthMessages++; // Heat-map phase will consume these; Phase 1 only counts them.
      return;
    }
    const t = parseAggTrade(m.data);
    if (!t) return;
    const prev = this.chains.get(t.symbol) ?? Promise.resolve();
    this.chains.set(t.symbol, prev.then(() => this.process(t)).catch((e) => this.log(`process error: ${(e as Error).message}`)));
  }

  private async process(t: Trade): Promise<void> {
    const gap = this.gaps.check(t.symbol, t.aggId);
    if (gap) {
      this.gapsFound++;
      this.log(`gap ${t.symbol}: ${gap.missing} trades missing (${gap.fromId}..${gap.toId})`);
      let recovered: Trade[] = [];
      const c = this.cfg.collector;
      if (c.backfillOnGap && gap.missing <= c.maxBackfillTrades) {
        try {
          recovered = await fetchAggTradesRange(c.restBaseUrl, t.symbol, gap.fromId, gap.toId, this.o.fetchJson);
        } catch (e) {
          this.log(`backfill failed for ${t.symbol}: ${(e as Error).message}`);
        }
      }
      this.store.recordGap(t.symbol, this.now(), gap.fromId, gap.toId, recovered.length);
      if (recovered.length) this.gapsRecovered++;
      this.buffer.push(...recovered);
      // Silent: keep candles/profile/delta consistent, but don't fire stale alerts or signals.
      for (const r of recovered) this.pipeline.onTrade(r, true);
    }
    this.buffer.push(t);
    this.pipeline.onTrade(t);
  }
}
