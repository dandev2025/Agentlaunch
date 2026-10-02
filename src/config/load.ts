import { readFileSync } from 'node:fs';
import type { Config } from './types.js';
import { TF_MS } from '../core/types.js';

export const DEFAULT_CONFIG_PATH = 'config/config.json';

export function loadConfig(path = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH): Config {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as Config;
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: Config): void {
  const errs: string[] = [];
  const pos = (v: unknown, name: string) => {
    if (typeof v !== 'number' || !(v > 0)) errs.push(`${name} must be a positive number`);
  };
  if (!Object.keys(cfg.assets ?? {}).length) errs.push('assets must not be empty');
  for (const [sym, a] of Object.entries(cfg.assets ?? {})) {
    pos(a.binSize, `assets.${sym}.binSize`);
    if (a.bigTrade?.minQty == null && a.bigTrade?.minNotionalUsd == null)
      errs.push(`assets.${sym}.bigTrade needs minQty and/or minNotionalUsd`);
  }
  for (const tf of cfg.timeframes ?? []) if (!(tf in TF_MS)) errs.push(`unknown timeframe ${tf}`);
  const fp = cfg.footprint;
  if (fp?.enabled) {
    for (const [sym, a] of Object.entries(cfg.assets)) pos(a.footprintBin, `assets.${sym}.footprintBin`);
    for (const tf of fp.timeframes) if (!cfg.timeframes.includes(tf)) errs.push(`footprint timeframe ${tf} must be listed in timeframes`);
    if (fp.stackedMin < 2) errs.push('footprint.stackedMin must be >= 2');
    pos(fp.imbalanceRatio, 'footprint.imbalanceRatio');
  }
  if (/\/(ws|stream|market|public|private)(\/|\?|$)/.test(cfg.collector?.wsBaseUrl ?? ''))
    errs.push('collector.wsBaseUrl must be the root (e.g. wss://fstream.binance.com): the collector adds /market and /public itself');
  if (!(cfg.volumeProfile?.minWarmupMinutes >= 0)) errs.push('volumeProfile.minWarmupMinutes must be >= 0');
  const hm = cfg.heatmap;
  if (hm?.enabled) {
    if (!cfg.collector.depth.enabled) errs.push('heatmap.enabled requires collector.depth.enabled');
    for (const [sym, a] of Object.entries(cfg.assets)) pos(a.wallMinQty, `assets.${sym}.wallMinQty`);
    if (!(hm.rangePct > 0 && hm.rangePct <= 0.1)) errs.push('heatmap.rangePct must be in (0, 0.1]');
    pos(hm.trackIntervalMs, 'heatmap.trackIntervalMs');
    if (hm.wall.dropFrac <= 0 || hm.wall.dropFrac >= 1) errs.push('heatmap.wall.dropFrac must be in (0,1)');
    if (hm.wall.holdFrac <= hm.wall.dropFrac || hm.wall.holdFrac > 1) errs.push('heatmap.wall.holdFrac must be in (dropFrac, 1]');
  }
  const gx = cfg.gex;
  if (gx?.enabled) {
    for (const [sym, cur] of Object.entries(gx.underlyings)) {
      if (!cfg.assets[sym]) errs.push(`gex.underlyings: unknown asset ${sym}`);
      if (cur !== 'BTC' && cur !== 'ETH') errs.push(`gex.underlyings.${sym}: only BTC and ETH are supported (got ${cur}); SOL options are too thin`);
    }
    pos(gx.pollIntervalMs, 'gex.pollIntervalMs');
    pos(gx.gridStepPct, 'gex.gridStepPct');
    if (!(gx.gridPct >= gx.gridStepPct)) errs.push('gex.gridPct must be >= gex.gridStepPct');
    if (gx.maxAgeMs < gx.pollIntervalMs) errs.push('gex.maxAgeMs must be >= gex.pollIntervalMs');
  }
  const s = cfg.signals;
  if (s) {
    pos(s.threshold, 'signals.threshold');
    if (s.minConditions < 3) errs.push('signals.minConditions must be >= 3 (single-indicator signals are not allowed)');
    if (s.minFamilies < 1) errs.push('signals.minFamilies must be >= 1');
    for (const tf of [s.deltaFlip.timeframe, s.htf.timeframe, s.risk.atrTimeframe])
      if (!cfg.timeframes.includes(tf)) errs.push(`timeframe ${tf} used by signals must be listed in timeframes`);
    const cf = s.confluence;
    if (cf?.enabled) {
      if (cf.stackFactor < 0 || cf.stackFactor > 1) errs.push('signals.confluence.stackFactor must be in [0,1]');
      if (cf.conflict.weight < 0) errs.push('signals.confluence.conflict.weight must be >= 0');
      for (const [k, v] of Object.entries(cf.familyBonus)) if (!Number.isInteger(Number(k)) || !(v > 0)) errs.push(`signals.confluence.familyBonus.${k} must map an integer family count to a positive multiplier`);
    }
    if (s.tracking.t1Fraction < 0 || s.tracking.t1Fraction > 1) errs.push('signals.tracking.t1Fraction must be in [0,1]');
  }
  for (const tf of cfg.alerts?.deltaDivergence?.timeframes ?? [])
    if (!cfg.timeframes.includes(tf)) errs.push(`alerts.deltaDivergence timeframe ${tf} must be listed in timeframes`);
  if (errs.length) throw new Error(`Invalid config:\n - ${errs.join('\n - ')}`);
}
