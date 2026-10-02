import type { Config } from '../config/types.js';
import type { Notifier } from '../alerts/notifier.js';
import { NullNotifier } from '../alerts/notifier.js';
import type { Store } from '../db/store.js';
import { Pipeline } from '../engine/pipeline.js';
import { WallTimeline } from './wallTimeline.js';

export interface ReplayOptions {
  runId: string;
  symbols?: string[];
  fromTs?: number;
  toTs?: number;
  notifier?: Notifier;
  /** Trades fed silently before `fromTs` so ATR/profile are warm. */
  warmupMinutes?: number;
  onProgress?: (processed: number, ts: number) => void;
}

export interface ReplayResult {
  runId: string;
  trades: number;
  fromTs: number;
  toTs: number;
  /** Number of stored walls available to the replay (0 => heat-map conditions can't fire). */
  walls: number;
  perSymbol: Record<string, { trades: number; bigTrades: number; alerts: number; signals: number; rejected: Record<string, number> }>;
}

/**
 * Runs the exact live rules over stored trades. Results are written under `runId` so they
 * never mix with live data and several parameter sets can be compared side by side.
 */
export function runReplay(store: Store, cfg: Config, o: ReplayOptions): ReplayResult {
  const symbols = (o.symbols ?? Object.keys(cfg.assets)).filter((s) => cfg.assets[s]?.enabled);
  const range = store.tradeRange(symbols);
  if (!range) throw new Error('No stored trades for the selected symbols. Run `npm run seed-synthetic` or `npm run backfill`.');
  const fromTs = o.fromTs ?? range.min;
  const toTs = o.toTs ?? range.max;

  const rs = store.withRun(o.runId);
  const warmFrom = fromTs - (o.warmupMinutes ?? 0) * 60_000;
  const timeline = cfg.heatmap.enabled ? WallTimeline.fromStore(store, symbols, warmFrom, toTs) : undefined;
  const pipeline = new Pipeline(cfg, { store: rs, notifier: o.notifier ?? new NullNotifier(), persistCandles: false, walls: timeline });

  let n = 0;
  rs.db.exec('BEGIN'); // one big transaction makes replay writes fast
  try {
    for (const t of store.iterTrades(symbols, warmFrom, toTs)) {
      pipeline.onTrade(t, t.ts < fromTs);
      if (t.ts >= fromTs && ++n % 200_000 === 0) o.onProgress?.(n, t.ts);
    }
    pipeline.flush();
    rs.db.exec('COMMIT');
  } catch (e) {
    rs.db.exec('ROLLBACK');
    throw e;
  }

  const perSymbol: ReplayResult['perSymbol'] = {};
  for (const [s, e] of pipeline.engines) perSymbol[s] = { ...e.stats };
  return { runId: o.runId, trades: n, fromTs, toTs, walls: timeline?.size ?? 0, perSymbol };
}
