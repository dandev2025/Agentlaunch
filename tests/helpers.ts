import { readFileSync } from 'node:fs';
import type { Config } from '../src/config/types.js';
import type { Candle, Trade } from '../src/core/types.js';

export function testConfig(over: (c: Config) => void = () => {}): Config {
  const c = JSON.parse(readFileSync('config/config.json', 'utf8')) as Config;
  over(c);
  return c;
}

let id = 1;
export const trade = (ts: number, price: number, size: number, side: 'buy' | 'sell' = 'buy', symbol = 'BTCUSDT'): Trade => ({
  symbol, aggId: id++, ts, price, size, side,
});

export const candle = (o: Partial<Candle>): Candle => ({
  symbol: 'BTCUSDT', tf: '5m', ts: 0, open: 100, high: 100, low: 100, close: 100,
  volume: 0, buyVolume: 0, sellVolume: 0, delta: 0, cvd: 0, trades: 1, ...o,
});
