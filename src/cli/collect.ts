import { loadConfig } from '../config/load.js';
import { Store } from '../db/store.js';
import { notifierFromEnv } from '../alerts/notifier.js';
import { LiveCollector } from '../collector/live.js';
import { HeatmapService } from '../collector/heatmap.js';
import { GexService } from '../collector/gex.js';
import { Pipeline } from '../engine/pipeline.js';
import { TelegramCommandListener } from '../alerts/telegramBot.js';
import { formatStatus, gatherStatus, HELP_TEXT } from '../collector/status.js';

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const notifier = notifierFromEnv();
const heat = cfg.heatmap.enabled ? new HeatmapService(cfg, store) : undefined;
const gex = cfg.gex.enabled ? new GexService(cfg, store) : undefined;
const pipeline = new Pipeline(cfg, { store, notifier, persistCandles: true, walls: heat, gex, log: (m) => console.log(`[signal] ${m}`) });
if (heat) heat.onWallEvent = (e) => pipeline.onWallEvent(e);
const collector = new LiveCollector(cfg, store, pipeline, { heat });

console.log(`Collecting ${pipeline.symbols.join(', ')} → ${cfg.dbPath}  (alerts and signals only — no order execution)`);
const startedAt = Date.now();
collector.warmup();
collector.start();
heat?.start();
gex?.start();

const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId } = process.env;
const bot = token && chatId
  ? new TelegramCommandListener(token, chatId, {
      status: () => formatStatus(gatherStatus(collector, pipeline, store, startedAt, undefined, heat, gex)),
      help: () => HELP_TEXT,
      start: () => HELP_TEXT,
    }, (text) => notifier.send(text))
  : null;
bot?.start();

const status = setInterval(() => {
  const s = [...pipeline.engines.values()].map((e) => `${e.symbol}: ${e.stats.trades}t/${e.stats.alerts}a/${e.stats.signals}s`).join('  ');
  console.log(`[status] ${s} msgs agg=${collector.aggMessages} depth=${collector.depthMessages} reconnects=${collector.reconnects} gaps=${collector.gapsFound}(${collector.gapsRecovered} recovered)`);
  for (const w of collector.health()) console.warn(`[WARN] ${w}`);
}, 60_000);

const shutdown = async () => {
  clearInterval(status);
  bot?.stop();
  heat?.stop();
  gex?.stop();
  await collector.stop();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
