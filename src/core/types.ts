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
