import { loadConfig } from '../config/load.js';
import { Store } from '../db/store.js';
import { runReplay } from '../backtest/replay.js';
import { buildReport, formatReport } from '../backtest/report.js';
import { notifierFromEnv } from '../alerts/notifier.js';
import { cli, parseTime } from './args.js';

const a = cli({
  db: { type: 'string' }, config: { type: 'string' }, run: { type: 'string' }, symbols: { type: 'string' },
  from: { type: 'string' }, to: { type: 'string' }, warmup: { type: 'string' }, telegram: { type: 'boolean' }, 'no-report': { type: 'boolean' },
});
const cfg = loadConfig(a.config as string | undefined);
const store = new Store((a.db as string) ?? cfg.dbPath);
const runId = (a.run as string) ?? `bt-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;

const res = runReplay(store, cfg, {
  runId,
  symbols: typeof a.symbols === 'string' ? a.symbols.split(',') : undefined,
  fromTs: parseTime(a.from),
  toTs: parseTime(a.to),
  warmupMinutes: Number(a.warmup ?? 120),
  notifier: a.telegram ? notifierFromEnv() : undefined, // off by default: never spam Telegram from a backtest
  onProgress: (n, ts) => console.log(`  …${n} trades, at ${new Date(ts).toISOString()}`),
});
console.log(`Replayed ${res.trades} trades ${new Date(res.fromTs).toISOString()} → ${new Date(res.toTs).toISOString()} as run "${runId}"`);
for (const [s, p] of Object.entries(res.perSymbol))
  console.log(`  ${s}: bigTrades=${p.bigTrades} alerts=${p.alerts} signals=${p.signals} rejected=${JSON.stringify(p.rejected)}`);
if (!a['no-report']) console.log('\n' + formatReport(buildReport(store, runId)));
