import { loadConfig } from '../config/load.js';
import { Store } from '../db/store.js';
import { notifierFromEnv } from '../alerts/notifier.js';
import { LiveCollector } from '../collector/live.js';
import { Pipeline } from '../engine/pipeline.js';

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const notifier = notifierFromEnv();
const pipeline = new Pipeline(cfg, { store, notifier, persistCandles: true, log: (m) => console.log(`[signal] ${m}`) });
const collector = new LiveCollector(cfg, store, pipeline);

console.log(`Collecting ${pipeline.symbols.join(', ')} → ${cfg.dbPath}  (alerts and signals only — no order execution)`);
collector.warmup();
collector.start();

const status = setInterval(() => {
  const s = [...pipeline.engines.values()].map((e) => `${e.symbol}: ${e.stats.trades}t/${e.stats.alerts}a/${e.stats.signals}s`).join('  ');
  console.log(`[status] ${s} reconnects=${collector.reconnects} gaps=${collector.gapsFound}(${collector.gapsRecovered} recovered)`);
}, 60_000);

const shutdown = async () => {
  clearInterval(status);
  await collector.stop();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
