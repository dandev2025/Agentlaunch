import type { Store } from '../db/store.js';
import { LIVE_RUN } from '../db/store.js';
import type { LiveCollector } from './live.js';
import type { Pipeline } from '../engine/pipeline.js';
import type { WallSource } from '../core/types.js';
import { fmtPrice, fmtTime } from '../core/format.js';

export interface StatusData {
  now: number;
  startedAt: number;
  ws: { connected: boolean; lastFrameAt: number; reconnects: number };
  gaps: { found: number; recovered: number };
  symbols: { symbol: string; price: number; lastTs: number; trades: number; bigTrades: number; openSignals: number; walls: number | null }[];
  last24h: { alerts: number; signals: number; open: number };
  lastSignal: { id: number; ts: number; symbol: string; direction: string; score: number } | null;
}

const dur = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

export function gatherStatus(c: LiveCollector, p: Pipeline, store: Store, startedAt: number, now = Date.now(), walls?: WallSource): StatusData {
  const one = (sql: string, ...a: any[]) => store.db.prepare(sql).get(...a) as any;
  const since = now - 86_400_000;
  const open = store.loadOpenSignals();
  const last = one('SELECT id, ts, symbol, direction, score FROM signals WHERE run_id = ? ORDER BY ts DESC, id DESC LIMIT 1', LIVE_RUN);
  return {
    now, startedAt,
    ws: { connected: c.connected, lastFrameAt: c.lastFrameAt, reconnects: c.reconnects },
    gaps: { found: c.gapsFound, recovered: c.gapsRecovered },
    symbols: [...p.engines.values()].map((e) => ({
      symbol: e.symbol, price: e.lastPrice, lastTs: e.lastTs, trades: e.stats.trades, bigTrades: e.stats.bigTrades,
      openSignals: open.filter((s) => s.symbol === e.symbol).length,
      walls: walls ? walls.activeWalls(e.symbol, now).length : null,
    })),
    last24h: {
      alerts: one('SELECT COUNT(*) c FROM alerts WHERE run_id = ? AND ts >= ?', LIVE_RUN, since).c,
      signals: one('SELECT COUNT(*) c FROM signals WHERE run_id = ? AND ts >= ?', LIVE_RUN, since).c,
      open: open.length,
    },
    lastSignal: last ? { id: last.id, ts: last.ts, symbol: last.symbol, direction: last.direction, score: last.score } : null,
  };
}

export function formatStatus(d: StatusData): string {
  const ws = d.ws.connected
    ? `🟢 connected (last frame ${d.ws.lastFrameAt ? dur(d.now - d.ws.lastFrameAt) + ' ago' : 'none yet'})`
    : '🔴 disconnected';
  const lines = [
    '📊 <b>Status</b>',
    `Uptime ${dur(d.now - d.startedAt)} · reconnects ${d.ws.reconnects}`,
    `WebSocket ${ws}`,
    `Gaps ${d.gaps.found} (${d.gaps.recovered} recovered)`,
    '',
    ...d.symbols.map(
      (s) =>
        `<b>${s.symbol}</b> ${s.trades ? fmtPrice(s.price) : '–'} · ${s.trades.toLocaleString('en-US')} trades` +
        `${s.trades ? ` · last ${dur(d.now - s.lastTs)} ago` : ''} · ${s.bigTrades} big · ${s.openSignals} open sig${s.walls == null ? '' : ` · ${s.walls} walls`}`,
    ),
    '',
    `Last 24h: ${d.last24h.alerts} alerts, ${d.last24h.signals} signals (${d.last24h.open} open now)`,
    d.lastSignal
      ? `Last signal: ${d.lastSignal.direction} ${d.lastSignal.symbol} score ${d.lastSignal.score} · #${d.lastSignal.id} · ${fmtTime(d.lastSignal.ts)}`
      : 'Last signal: none yet',
  ];
  return lines.join('\n');
}

export const HELP_TEXT = '/status — collector health, per-asset activity, signal counts\n/help — this message';
