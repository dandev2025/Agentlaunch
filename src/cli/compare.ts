import { loadConfig } from '../config/load.js';
import { Store } from '../db/store.js';
import { compareRuns, formatComparison } from '../backtest/compare.js';
import { cli } from './args.js';

// Compare two replay runs, e.g.:
//   npm run replay -- --run on  --no-report
//   npm run replay -- --run off --no-report --config config/no-confluence.json
//   npm run compare -- --a off --b on
const a = cli({ db: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' }, json: { type: 'boolean' } });
if (typeof a.a !== 'string' || typeof a.b !== 'string') throw new Error('usage: npm run compare -- --a <runId> --b <runId>');
const cfg = loadConfig();
const store = new Store((a.db as string) ?? cfg.dbPath);
const c = compareRuns(store, a.a, a.b);
console.log(a.json ? JSON.stringify(c, (_, v) => (v === Infinity ? 'Infinity' : v), 2) : formatComparison(c));
