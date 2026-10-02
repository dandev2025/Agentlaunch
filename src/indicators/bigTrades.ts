import type { AssetConfig } from '../config/types.js';
import type { BigTrade, Trade } from '../core/types.js';

export function isBigTrade(t: Trade, cfg: AssetConfig['bigTrade']): boolean {
  const notional = t.price * t.size;
  return (cfg.minQty != null && t.size >= cfg.minQty) || (cfg.minNotionalUsd != null && notional >= cfg.minNotionalUsd);
}

export function toBigTrade(t: Trade): BigTrade {
  return { symbol: t.symbol, aggId: t.aggId, ts: t.ts, price: t.price, size: t.size, notional: t.price * t.size, side: t.side };
}

/** Keeps recent big trades for "big prints at the level" checks. */
export class BigTradeBuffer {
  private items: BigTrade[] = [];
  constructor(private windowMs: number) {}

  add(b: BigTrade): void {
    this.items.push(b);
    this.prune(b.ts);
  }

  prune(now: number): void {
    const cut = now - this.windowMs;
    let i = 0;
    while (i < this.items.length && this.items[i].ts < cut) i++;
    if (i) this.items.splice(0, i);
  }

  recent(now: number): BigTrade[] {
    this.prune(now);
    return this.items;
  }
}
