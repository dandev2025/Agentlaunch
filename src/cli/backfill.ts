import { loadConfig } from '../config/load.js';
import { Store } from '../db/store.js';
import { fetchAggTradesByTime } from '../collector/gaps.js';
import { cli, parseTime } from './args.js';

// Downloads historical aggTrades from Binance's public REST API (no key needed) for replay.
const a = cli({ db: { type: 'string' }, symbols: { type: 'string' }, hours: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } });
const cfg = loadConfig();
const store = new Store((a.db as string) ?? cfg.dbPath);
const symbols = typeof a.symbols === 'string' ? a.symbols.split(',') : Object.keys(cfg.assets).filter((s) => cfg.assets[s].enabled);
const to = parseTime(a.to) ?? Date.now();
const from = parseTime(a.from) ?? to - Number(a.hours ?? 6) * 3_600_000;

for (const s of symbols) {
  let n = 0;
  await fetchAggTradesByTime(cfg.collector.restBaseUrl, s, from, to, (page) => { n += store.insertTrades(page); });
  console.log(`${s}: stored ${n} trades (${new Date(from).toISOString()} → ${new Date(to).toISOString()})`);
}
