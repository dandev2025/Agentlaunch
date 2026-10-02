import type { LevelKind, Timeframe } from '../core/types.js';

export interface AssetConfig {
  enabled: boolean;
  /** Volume-profile price bin (quote currency). */
  binSize: number;
  /** A trade is "big" if size >= minQty OR notional >= minNotionalUsd (whichever is set). */
  bigTrade: { minQty: number | null; minNotionalUsd: number | null };
}

export interface Config {
  dbPath: string;
  assets: Record<string, AssetConfig>;
  timeframes: Timeframe[];
  collector: {
    wsBaseUrl: string;
    restBaseUrl: string;
    depth: { enabled: boolean; levels: number; speedMs: number };
    pingIntervalMs: number;
    staleAfterMs: number;
    reconnectMinDelayMs: number;
    reconnectMaxDelayMs: number;
    flushIntervalMs: number;
    backfillOnGap: boolean;
    maxBackfillTrades: number;
    warmupMinutes: number;
  };
  proximity: { atrMult: number; minBins: number; fallbackPct: number };
  volumeProfile: {
    windowMinutes: number;
    valueAreaPct: number;
    hvnFactor: number;
    hvnMinSepBins: number;
    hvnSmoothBins: number;
    recomputeMs: number;
  };
  alerts: {
    maxAgeMs: number;
    bigTradeAtLevel: { enabled: boolean; levels: LevelKind[]; cooldownMs: number };
    deltaDivergence: {
      enabled: boolean;
      timeframes: Timeframe[];
      lookbackCandles: number;
      cooldownMs: number;
    };
  };
  signals: {
    enabled: boolean;
    threshold: number;
    minConditions: number;
    minFamilies: number;
    cooldownMs: number;
    conditionTtlMs: number;
    weights: Record<string, number>;
    deltaFlip: { timeframe: Timeframe; minMultOfAvg: number; avgLookback: number };
    bigPrints: { windowMs: number; minCount: number };
    htf: {
      timeframe: Timeframe;
      lookbackCandles: number;
      historyCandles: number;
      minHistory: number;
      strongZ: number;
    };
    risk: {
      atrTimeframe: Timeframe;
      atrPeriod: number;
      stopAtrMult: number;
      entryZoneAtr: number;
      minTargetAtr: number;
      fallbackT2Atr: number;
      minRR: number;
      rrBasis: 'T1' | 'T2';
    };
    tracking: { maxHoldMs: number; t1Fraction: number };
  };
}
