import path from 'node:path';
import { loadConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/types.js';

let cached: { path: string; cfg: Config } | null = null;

/** The same config file the collector uses (thresholds, assets, footprint/profile settings). */
export function dashConfig(): Config {
  const p = process.env.CONFIG_PATH ?? path.resolve(process.cwd(), '..', 'config', 'config.json');
  if (!cached || cached.path !== p) cached = { path: p, cfg: loadConfig(p) };
  return cached.cfg;
}
