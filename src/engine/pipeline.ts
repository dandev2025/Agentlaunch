import type { Config } from '../config/types.js';
import type { Trade } from '../core/types.js';
import { AssetEngine, type EngineDeps } from './assetEngine.js';

export class Pipeline {
  readonly engines = new Map<string, AssetEngine>();

  constructor(readonly cfg: Config, deps: EngineDeps) {
    for (const [sym, a] of Object.entries(cfg.assets)) {
      if (a.enabled) this.engines.set(sym, new AssetEngine(sym, cfg, deps));
    }
  }

  get symbols(): string[] {
    return [...this.engines.keys()];
  }

  onTrade(t: Trade, silent = false): void {
    const e = this.engines.get(t.symbol);
    if (!e) return;
    const prev = e.silent;
    e.silent = silent;
    try {
      e.onTrade(t);
    } finally {
      e.silent = prev;
    }
  }

  flush(): void {
    for (const e of this.engines.values()) e.tracker.flush();
  }
}
