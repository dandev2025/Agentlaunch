import path from 'node:path';
import { loadConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/types.js';

let cached: { path: string; cfg: Config } | null = null;

/** The same config file the collector uses (thresholds, assets, footprint/profile settings). */
/** `CONFIG_PATH` may be absolute or relative to the repo root (not to `dashboard/`). */
export function configPath(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): string {
  return path.resolve(cwd, '..', env.CONFIG_PATH ?? path.join('config', 'config.json'));
}

export function dashConfig(): Config {
  const p = configPath();
  if (!cached || cached.path !== p) cached = { path: p, cfg: loadConfig(p) };
  return cached.cfg;
}
