import type { Config } from '../config/types.js';
import type { Trade } from '../core/types.js';
import type { Store } from '../db/store.js';
import type { Pipeline } from '../engine/pipeline.js';
import { BinanceStream, parseAggTrade, streamUrl, type StreamKind, type WsFactory } from './binance.js';
import { fetchAggTradesRange, GapDetector, type FetchJson } from './gaps.js';
import type { HeatmapService } from './heatmap.js';

export interface LiveOptions {
  wsFactory?: WsFactory;
  fetchJson?: FetchJson;
  /** Heat-map service that consumes depth messages and live trades (optional). */
  heat?: HeatmapService;
  log?: (msg: string) => void;
  now?: () => number;
}

/**
 * Live runner: WebSocket -> gap check/backfill -> SQLite (batched) -> Pipeline.
 * Messages are serialised per symbol so backfilled trades are always processed before the
 * live trade that revealed the gap.
 */
export class LiveCollector {
  /** One connection per Binance endpoint: trades on /market, order book on /public (only when the heat map is on). */
  private streams: { kind: StreamKind; stream: BinanceStream }[] = [];
  private openedAt: Record<StreamKind, number | null> = { market: null, public: null };
  private unparsedSamples = 0;
  private gaps = new GapDetector();
  private chains = new Map<string, Promise<void>>();
  private buffer: Trade[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private log: (m: string) => void;
  private now: () => number;
  aggMessages = 0;
  depthMessages = 0;
  /** Frames that were neither a depth update nor a readable aggTrade (the first few are logged). */
  unparsedMessages = 0;
  gapsFound = 0;
  gapsRecovered = 0;

  constructor(private cfg: Config, private store: Store, private pipeline: Pipeline, private o: LiveOptions = {}) {
    this.log = o.log ?? ((m) => console.log(`[collector] ${m}`));
    this.now = o.now ?? Date.now;
    const c = cfg.collector;
    const kinds: StreamKind[] = ['market'];
    if (c.depth.enabled && o.heat) kinds.push('public'); // nobody would consume depth without the heat-map service
    for (const kind of kinds) {
      this.streams.push({
        kind,
        stream: new BinanceStream({
          url: streamUrl(c.wsBaseUrl, kind, pipeline.symbols, c.depth),
          pingIntervalMs: c.pingIntervalMs,
          staleAfterMs: c.staleAfterMs,
          reconnectMinDelayMs: c.reconnectMinDelayMs,
          reconnectMaxDelayMs: c.reconnectMaxDelayMs,
          wsFactory: o.wsFactory,
          onStatus: (s, info) => {
            this.log(`ws[${kind}] ${s}${info ? `: ${info}` : ''}`);
            this.openedAt[kind] = s === 'open' ? this.now() : s === 'connecting' ? this.openedAt[kind] : null;
            // Depth events are lost while the order-book connection is down, so any open book can no longer be trusted.
            if (kind === 'public' && (s === 'closed' || s === 'stale')) this.o.heat?.onStreamReconnect();
          },
          onMessage: (m) => this.onMessage(m),
        }),
      });
    }
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
    for (const x of this.streams) x.stream.start();
  }

  async stop(): Promise<void> {
    for (const x of this.streams) x.stream.stop();
    if (this.flushTimer) clearInterval(this.flushTimer);
    await Promise.all(this.chains.values());
    this.flush();
    this.pipeline.flush();
  }

  /** The trade connection is up (the one everything depends on). */
  get connected(): boolean {
    return this.streams.find((x) => x.kind === 'market')?.stream.connected ?? false;
  }

  /** When the last frame arrived on the trade connection. */
  get lastFrameAt(): number {
    return this.streams.find((x) => x.kind === 'market')?.stream.lastFrameAt ?? 0;
  }

  get reconnects(): number {
    return this.streams.reduce((n, x) => n + x.stream.reconnects, 0);
  }

  /**
   * Things that look broken even though nothing crashed — chiefly a connection that is open but delivers nothing
   * (which is exactly what a changed Binance endpoint looks like). Printed with every status line.
   */
  health(now = this.now()): string[] {
    const w: string[] = [];
    const silentFor = (kind: StreamKind) => (this.openedAt[kind] == null ? 0 : now - this.openedAt[kind]!);
    if (silentFor('market') > 60_000 && this.aggMessages === 0)
      w.push(`connected to the trade stream for ${Math.round(silentFor('market') / 1000)}s but no trades have arrived — Binance may have changed its endpoints (see README, "Binance WebSocket endpoints")`);
    if (this.streams.some((x) => x.kind === 'public') && silentFor('public') > 60_000 && this.depthMessages === 0)
      w.push(`connected to the order-book stream for ${Math.round(silentFor('public') / 1000)}s but no depth updates have arrived`);
    if (this.unparsedMessages > 0) w.push(`${this.unparsedMessages} message(s) could not be read (check the log for samples)`);
    return w;
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
      this.depthMessages++;
      const d = m.data;
      if (d?.e === 'depthUpdate' && typeof d.s === 'string') this.o.heat?.onDepth(d.s, { U: d.U, u: d.u, pu: d.pu, b: d.b ?? [], a: d.a ?? [] });
      return;
    }
    const t = parseAggTrade(m.data);
    if (!t) {
      this.unparsedMessages++;
      if (this.unparsedSamples++ < 3) this.log(`unreadable message on ${m.stream}: ${JSON.stringify(m.data).slice(0, 200)}`);
      return;
    }
    this.aggMessages++;
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
    this.o.heat?.onTrade(t);
    this.pipeline.onTrade(t);
  }
}
