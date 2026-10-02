import { loadConfig } from '../config/load.js';
import { Store } from '../db/store.js';
import { DEFAULT_SYNTH, generateSynthetic } from '../backtest/synthetic.js';
import { cli, parseTime } from './args.js';

const a = cli({ db: { type: 'string' }, hours: { type: 'string' }, seed: { type: 'string' }, start: { type: 'string' } });
const cfg = loadConfig();
const store = new Store((a.db as string) ?? cfg.dbPath);
const hours = Number(a.hours ?? 12);
const start = parseTime(a.start) ?? Date.parse('2026-01-01T00:00:00Z');
const assets = DEFAULT_SYNTH.filter((s) => cfg.assets[s.symbol]?.enabled);

let batch: ReturnType<typeof generateSynthetic> extends Generator<infer T> ? T[] : never = [];
let total = 0;
for (const t of generateSynthetic(assets, start, hours, Number(a.seed ?? 42))) {
  batch.push(t);
  if (batch.length >= 20_000) { total += store.insertTrades(batch); batch = []; }
}
total += store.insertTrades(batch);
console.log(`Inserted ${total} SYNTHETIC trades (${hours}h from ${new Date(start).toISOString()}). Not real market data.`);
