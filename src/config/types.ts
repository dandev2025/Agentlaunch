import type { LevelKind, Timeframe, WallEventType } from '../core/types.js';
import type { FootprintOptions } from '../indicators/footprint.js';

export interface AssetConfig {
  enabled: boolean;
  /** Volume-profile price bin (quote currency). */
  binSize: number;
  /** Minimum resting size (base units) for a book level to count as a wall. */
  wallMinQty: number;
  /** Footprint price bin (finer than the profile bin). */
  footprintBin: number;
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
    /** Diff depth stream + REST snapshot of `snapshotLimit` levels, for the heat map. */
    depth: { enabled: boolean; snapshotLimit: number; speedMs: number };
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
  footprint: FootprintOptions & {
    enabled: boolean;
    timeframes: Timeframe[];
    /** Store footprint levels in `footprint_levels` (live only). */
    persist: boolean;
    /** Footprint conditions only count when the event zone is at/near the level the signal is built on. */
    requireAtLevel: boolean;
  };
  heatmap: {
    enabled: boolean;
    trackIntervalMs: number;
    /** Book range tracked around mid, as a fraction of price (0.01 = ±1%). */
    rangePct: number;
    snapshot: { persist: boolean; intervalMs: number; retentionHours: number };
    wall: {
      /** A level is a wall if size >= max(wallMinQty, relMult x median level size in range). */
      relMult: number;
      /** A wall ends when its size falls below dropFrac x its peak. */
      dropFrac: number;
      /** Ended wall counts as "eaten" (vs "pulled") if traded volume at it >= eatenFrac x peak, or price swept through. */
      eatenFrac: number;
      /** Record a size-change event when size moves by this fraction. */
      changeFrac: number;
      /** For signals: wall must be at least this old (filters flash/spoof orders)... */
      minAgeMs: number;
      /** ...and still hold >= holdFrac x its peak size. */
      holdFrac: number;
    };
    /** Wall condition only counts when the wall sits at/near the profile level the signal is built on. */
    requireAtLevel: boolean;
  };
  /** Deribit options GEX. Only BTC and ETH: SOL options are too thin to say anything. */
  gex: {
    enabled: boolean;
    baseUrl: string;
    pollIntervalMs: number;
    /** Binance symbol -> Deribit currency (BTC | ETH). */
    underlyings: Record<string, 'BTC' | 'ETH'>;
    minHoursToExpiry: number;
    maxDaysToExpiry: number;
    gridPct: number;
    gridStepPct: number;
    persist: boolean;
    /** Signals ignore a snapshot older than this. */
    maxAgeMs: number;
    /** Price must be at least this fraction beyond the flip level for the condition to count. */
    minDistancePct: number;
  };
  alerts: {
    maxAgeMs: number;
    bigTradeAtLevel: { enabled: boolean; levels: LevelKind[]; cooldownMs: number };
    wall: { enabled: boolean; events: WallEventType[]; levels: LevelKind[]; cooldownMs: number };
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
