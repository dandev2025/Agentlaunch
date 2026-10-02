import WebSocket from 'ws';
import type { Side, Trade } from '../core/types.js';

export interface WsLike {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: any) => void): unknown;
  on(event: 'close', cb: (code: number) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'pong', cb: () => void): unknown;
  ping(): void;
  terminate(): void;
  close(): void;
}

export type WsFactory = (url: string) => WsLike;
export const defaultWsFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

export function streamUrl(
  base: string,
  symbols: string[],
  depth: { enabled: boolean; levels: number; speedMs: number },
): string {
  const streams = symbols.flatMap((s) => {
    const l = s.toLowerCase();
    const out = [`${l}@aggTrade`];
    if (depth.enabled) out.push(`${l}@depth${depth.levels}@${depth.speedMs}ms`);
    return out;
  });
  return `${base.replace(/\/$/, '')}/stream?streams=${streams.join('/')}`;
}

/** Binance: `m` = buyer is the maker, so the aggressor was a seller. */
export function parseAggTrade(d: any): Trade | null {
  if (!d || d.e !== 'aggTrade') return null;
  const price = Number(d.p), size = Number(d.q), aggId = Number(d.a), ts = Number(d.T);
  if (![price, size, aggId, ts].every(Number.isFinite)) return null;
  return { symbol: String(d.s), aggId, ts, price, size, side: (d.m ? 'sell' : 'buy') as Side };
}

export interface StreamOptions {
  url: string;
  pingIntervalMs: number;
  staleAfterMs: number;
  reconnectMinDelayMs: number;
  reconnectMaxDelayMs: number;
  onMessage: (msg: { stream: string; data: any }) => void;
  onStatus?: (s: 'connecting' | 'open' | 'closed' | 'stale', info?: string) => void;
  wsFactory?: WsFactory;
  random?: () => number;
}

/**
 * Self-healing combined-stream client: exponential backoff + jitter on close/error, ping
 * heartbeat, and a staleness watchdog (no frame for `staleAfterMs` => kill and reconnect).
 * Binance also drops connections every ~24h, which this handles like any other disconnect.
 */
export class BinanceStream {
  private ws: WsLike | null = null;
  private attempt = 0;
  private lastMsgAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = true;
  reconnects = 0;

  constructor(private o: StreamOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = this.retry = null;
    this.ws?.terminate();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.o.onStatus?.('connecting', this.o.url);
    const ws = (this.o.wsFactory ?? defaultWsFactory)(this.o.url);
    this.ws = ws;
    let dead = false;
    const die = (why: string) => {
      if (dead || this.ws !== ws) return;
      dead = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      try { ws.terminate(); } catch { /* already closed */ }
      this.ws = null;
      this.o.onStatus?.('closed', why);
      this.scheduleReconnect();
    };

    ws.on('open', () => {
      this.attempt = 0;
      this.lastMsgAt = Date.now();
      this.o.onStatus?.('open');
      this.timer = setInterval(() => {
        if (Date.now() - this.lastMsgAt > this.o.staleAfterMs) {
          this.o.onStatus?.('stale', `no frames for ${this.o.staleAfterMs}ms`);
          die('stale');
          return;
        }
        try { ws.ping(); } catch { die('ping failed'); }
      }, this.o.pingIntervalMs);
    });
    ws.on('pong', () => { this.lastMsgAt = Date.now(); });
    ws.on('message', (raw) => {
      this.lastMsgAt = Date.now();
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.stream && msg.data) this.o.onMessage(msg);
      } catch (e) {
        this.o.onStatus?.('closed', `bad frame: ${(e as Error).message}`);
      }
    });
    ws.on('error', (e) => die(`error: ${e.message}`));
    ws.on('close', (code) => die(`closed (${code})`));
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const base = Math.min(this.o.reconnectMaxDelayMs, this.o.reconnectMinDelayMs * 2 ** this.attempt++);
    const delay = Math.round(base * (0.5 + (this.o.random ?? Math.random)() * 0.5));
    this.reconnects++;
    this.retry = setTimeout(() => this.connect(), delay);
  }
}
