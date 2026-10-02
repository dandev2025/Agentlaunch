import type { Trade } from '../core/types.js';

/** Deterministic PRNG so synthetic runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthAsset {
  symbol: string;
  startPrice: number;
  medianSize: number;
  /** Multiplier on median size for a "big" print. */
  bigMult: number;
}

/**
 * Plausible-looking *fake* order flow: price oscillates between two slowly moving attractor
 * levels (so volume piles up into nodes), flow leans toward the active attractor, and big prints
 * cluster near the levels. It exists so replay/backtest/tests run offline. Backtest results on it
 * say nothing about real markets.
 */
export function* generateSynthetic(assets: SynthAsset[], startTs: number, hours: number, seed = 42): Generator<Trade> {
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const endTs = startTs + hours * 3_600_000;
  const st = assets.map((a, i) => ({
    a, price: a.startPrice, aggId: 1000 * (i + 1), lvlA: a.startPrice, lvlB: a.startPrice * 1.006, onA: false, switchAt: startTs,
  }));
  for (let ts = startTs; ts < endTs; ts += 250) {
    for (const s of st) {
      if (ts >= s.switchAt) {
        s.onA = !s.onA;
        s.switchAt = ts + (10 + rnd() * 25) * 60_000;
        if (rnd() < 0.2) { // occasionally re-anchor the range
          const shift = s.a.startPrice * 0.004 * gauss();
          s.lvlA += shift; s.lvlB += shift;
        }
      }
      const target = s.onA ? s.lvlA : s.lvlB;
      const n = rnd() < 0.55 ? 1 + Math.floor(rnd() * 2) : 0;
      for (let k = 0; k < n; k++) {
        const pull = (target - s.price) / s.price;
        s.price *= 1 + pull * 0.0025 + gauss() * 0.00008;
        const lean = Math.max(-0.35, Math.min(0.35, pull * 60));
        const side = rnd() < 0.5 + lean ? 'buy' : 'sell';
        const nearLevel = Math.min(Math.abs(s.price - s.lvlA), Math.abs(s.price - s.lvlB)) / s.price < 0.0006;
        let size = s.a.medianSize * Math.exp(gauss() * 0.9);
        if (rnd() < (nearLevel ? 0.012 : 0.0015)) size = s.a.medianSize * s.a.bigMult * (1 + rnd());
        yield { symbol: s.a.symbol, aggId: s.aggId++, ts: ts + k * 20, price: +s.price.toFixed(6), size: +size.toFixed(4), side };
      }
    }
  }
}

export const DEFAULT_SYNTH: SynthAsset[] = [
  { symbol: 'BTCUSDT', startPrice: 65000, medianSize: 0.02, bigMult: 150 },
  { symbol: 'ETHUSDT', startPrice: 2600, medianSize: 0.5, bigMult: 160 },
  { symbol: 'SOLUSDT', startPrice: 150, medianSize: 15, bigMult: 130 },
];
