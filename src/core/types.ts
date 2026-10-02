export type Side = 'buy' | 'sell';
export type Direction = 'LONG' | 'SHORT';
export type Timeframe = '1m' | '5m' | '15m';

export const TF_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
};

/** One Binance aggTrade. `side` is the aggressor (taker) side. */
export interface Trade {
  symbol: string;
  aggId: number;
  ts: number; // ms
  price: number;
  size: number; // base-asset quantity
  side: Side;
}

export interface Candle {
  symbol: string;
  tf: Timeframe;
  ts: number; // candle open time, ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number; // buyVolume - sellVolume
  cvd: number; // cumulative delta at candle close (since engine start / replay start)
  trades: number;
}

export type LevelKind = 'VAL' | 'VAH' | 'POC' | 'HVN';

export interface Level {
  kind: LevelKind;
  price: number;
  volume?: number;
}

export interface ProfileSnapshot {
  ts: number;
  poc: number;
  vah: number;
  val: number;
  hvns: { price: number; volume: number }[];
  totalVolume: number;
  binSize: number;
}

export interface BigTrade {
  symbol: string;
  aggId: number;
  ts: number;
  price: number;
  size: number;
  notional: number;
  side: Side;
}

export interface Divergence {
  symbol: string;
  tf: Timeframe;
  ts: number;
  type: 'bullish' | 'bearish';
  price: number; // extreme made by the latest candle
  refPrice: number; // prior extreme
  cvd: number;
  refCvd: number;
}

export const dirOfSide = (s: Side): Direction => (s === 'buy' ? 'LONG' : 'SHORT');
export const sign = (d: Direction): 1 | -1 => (d === 'LONG' ? 1 : -1);

/** Footprint: aggressive volume per price level. `ask` = aggressive buys (lift the ask), `bid` = aggressive sells (hit the bid). */
export interface FootprintLevel {
  price: number;
  bid: number;
  ask: number;
  trades: number;
}

export interface FootprintCandle {
  symbol: string;
  tf: Timeframe;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  binSize: number;
  levels: FootprintLevel[]; // dense: ascending price, no holes (empty levels have zero volume)
  totalBid: number;
  totalAsk: number;
}

export interface FootprintEvent {
  kind: 'stacked_imbalance' | 'absorption';
  /** Direction this event supports: stacked buy imbalance / sell absorption => LONG; mirror => SHORT. */
  direction: Direction;
  symbol: string;
  tf: Timeframe;
  ts: number; // candle open
  lo: number;
  hi: number;
  detail: Record<string, unknown>;
}

// ---- heat map -------------------------------------------------------------------
export type WallSide = 'bid' | 'ask';
export type WallEventType = 'added' | 'changed' | 'pulled' | 'eaten' | 'expired';

/** A large resting order-book level (aggregated to the asset's price bin). */
export interface WallView {
  id: number;
  side: WallSide;
  price: number;
  size: number; // current resting size (base units)
  peak: number;
  firstSeen: number;
  executed: number; // aggressive volume traded into it while it lived
}

export interface WallEvent {
  type: WallEventType;
  symbol: string;
  ts: number;
  wall: WallView;
  detail: { lifetimeMs: number; spoofLike: boolean; [k: string]: unknown };
}

/** Where the engine asks "which walls are standing at time ts?" — live tracker or replay timeline. */
export interface WallSource {
  activeWalls(symbol: string, ts: number): WallView[];
}

// ---- GEX (Deribit options, BTC/ETH only) -----------------------------------------
export interface GexStrike {
  strike: number;
  callGex: number; // dealer dollar-gamma per 1% move, calls (+)
  putGex: number; // puts (-)
  gex: number; // net
  oi: number; // call + put open interest, underlying units
}

export interface GexSnapshot {
  underlying: string; // BTC | ETH
  ts: number;
  spot: number;
  /** Price where net GEX changes sign (nearest to spot, within the search grid); null if none found. */
  flipLevel: number | null;
  totalGex: number; // net dollar-gamma per 1% move at spot
  strikes: GexStrike[];
  instruments: number;
}

export interface GexView {
  underlying: string;
  ts: number;
  spot: number;
  flipLevel: number | null;
  totalGex: number;
}

export interface GexSource {
  /** Latest GEX snapshot at or before `ts` for this Binance symbol (null for assets without options data). */
  gexFor(symbol: string, ts: number): GexView | null;
}
