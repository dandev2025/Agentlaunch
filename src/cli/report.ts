import { loadConfig } from '../config/load.js';
import { Store } from '../db/store.js';
import { buildReport, formatReport } from '../backtest/report.js';
import { cli } from './args.js';

const a = cli({ db: { type: 'string' }, run: { type: 'string' }, symbol: { type: 'string' }, json: { type: 'boolean' } });
const cfg = loadConfig();
const store = new Store((a.db as string) ?? cfg.dbPath);
const runId = (a.run as string) ?? 'live';
const rep = buildReport(store, runId, { symbol: a.symbol as string | undefined });
console.log(a.json ? JSON.stringify(rep, (_, v) => (v === Infinity ? 'Infinity' : v), 2) : formatReport(rep));
