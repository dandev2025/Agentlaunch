import type { Config } from '../config/types.js';
import { TF_MS, type Candle, type Direction, type Timeframe, type Trade } from '../core/types.js';
import type { Store } from '../db/store.js';
import { Cooldown } from '../alerts/cooldown.js';
import type { Notifier } from '../alerts/notifier.js';
import { bigTradeAtLevel, divergenceMessage } from '../alerts/rules.js';
import { Atr } from '../indicators/atr.js';
import { BigTradeBuffer, isBigTrade, toBigTrade } from '../indicators/bigTrades.js';
import { CandleBuilder } from '../indicators/candles.js';
import { detectDeltaFlip, detectDivergence, htfDeltaZ } from '../indicators/divergence.js';
import { VolumeProfile } from '../indicators/volumeProfile.js';
import { evaluateDirection, type Candidate, type RecentEvent } from '../signals/evaluate.js';
import { signalMessage } from '../signals/format.js';
import { SignalTracker } from '../signals/tracker.js';

export interface EngineDeps {
  store: Store;
  notifier: Notifier;
  /** Persist closed candles (live only; replay derives them from trades). */
  persistCandles?: boolean;
  log?: (msg: string) => void;
}

export interface EngineStats {
  trades: number;
  bigTrades: number;
  alerts: number;
  signals: number;
  rejected: Record<string, number>;
}

/** All per-asset state. The same code path serves live, warm-up and replay; time comes from trades. */
export class AssetEngine {
  readonly builders = new Map<Timeframe, CandleBuilder>();
  readonly profile: VolumeProfile;
  readonly bigBuf: BigTradeBuffer;
  readonly tracker: SignalTracker;
  readonly stats: EngineStats = { trades: 0, bigTrades: 0, alerts: 0, signals: 0, rejected: {} };
  private atr: Atr;
  private cooldown = new Cooldown();
  private flips: RecentEvent[] = [];
  private divs: RecentEvent[] = [];
  private snapCache: { ts: number; snap: ReturnType<VolumeProfile['snapshot']> } | null = null;
  private lastPrice = 0;
  private evalDue = false;
  /** While true: state is updated but no alerts / new signals are produced (warm-up, backfill). */
  silent = false;

  constructor(readonly symbol: string, private cfg: Config, private deps: EngineDeps) {
    const a = cfg.assets[symbol];
    for (const tf of cfg.timeframes) this.builders.set(tf, new CandleBuilder(symbol, tf));
    this.profile = new VolumeProfile({
      binSize: a.binSize,
      windowMs: cfg.volumeProfile.windowMinutes * 60_000,
      valueAreaPct: cfg.volumeProfile.valueAreaPct,
      hvnFactor: cfg.volumeProfile.hvnFactor,
      hvnMinSepBins: cfg.volumeProfile.hvnMinSepBins,
      hvnSmoothBins: cfg.volumeProfile.hvnSmoothBins,
    });
    this.bigBuf = new BigTradeBuffer(cfg.signals.bigPrints.windowMs);
    this.atr = new Atr(cfg.signals.risk.atrPeriod);
    this.tracker = new SignalTracker(cfg.signals.tracking, (id, u) => deps.store.updateSignal(id, u));
    for (const s of deps.store.loadOpenSignals(symbol)) this.tracker.add(s);
  }

  private snapshot(now: number) {
    if (!this.snapCache || now - this.snapCache.ts >= this.cfg.volumeProfile.recomputeMs) {
      this.snapCache = { ts: now, snap: this.profile.snapshot(now) };
    }
    return this.snapCache.snap;
  }

  /** "At or near": ATR-scaled, floored at a few bins; percent-of-price until ATR is warm. */
  nearDistance(price: number): number {
    const p = this.cfg.proximity;
    const floor = p.minBins * this.cfg.assets[this.symbol].binSize;
    return Math.max(this.atr.value != null ? p.atrMult * this.atr.value : price * p.fallbackPct, floor);
  }

  onTrade(t: Trade): void {
    const { cfg, deps } = this;
    this.stats.trades++;
    this.lastPrice = t.price;
    this.profile.add(t.ts, t.price, t.size);
    this.tracker.onPrice(this.symbol, t.ts, t.price);

    // Candles / delta. Signals are evaluated after every timeframe has seen this trade, so a
    // 5m/15m boundary event is visible to the 1m-close evaluation that coincides with it.
    this.evalDue = false;
    for (const [tf, b] of this.builders) {
      const closed = b.add(t);
      if (closed) this.onCandleClosed(tf, closed, t.ts);
    }
    if (this.evalDue && !this.silent) this.evaluateSignals(t.ts);

    // Big trades
    if (isBigTrade(t, cfg.assets[this.symbol].bigTrade)) {
      const big = toBigTrade(t);
      this.bigBuf.add(big);
      this.stats.bigTrades++;
      if (!this.silent) {
        deps.store.recordBigTrade(big);
        const rule = cfg.alerts.bigTradeAtLevel;
        const snap = this.snapshot(t.ts);
        if (rule.enabled && snap) {
          const hit = bigTradeAtLevel(big, snap, rule.levels, this.nearDistance(t.price));
          if (hit && this.cooldown.tryFire(`btl:${this.symbol}:${big.side}:${hit.level.kind}:${hit.level.price}`, t.ts, rule.cooldownMs)) {
            this.emitAlert(t.ts, 'big_trade_at_level', hit.message, hit.inputs);
          }
        }
      }
    }
  }

  private emitAlert(ts: number, type: string, message: string, inputs: unknown): void {
    this.stats.alerts++;
    this.deps.store.recordAlert(ts, this.symbol, type, message, inputs);
    this.deps.notifier.send(message);
  }

  private onCandleClosed(tf: Timeframe, c: Candle, now: number): void {
    const { cfg } = this;
    if (this.deps.persistCandles && !this.silent) this.deps.store.recordCandle(c);
    const hist = this.builders.get(tf)!.history;
    const evCfg = cfg.signals;

    if (tf === evCfg.risk.atrTimeframe) this.atr.update(c);

    if (tf === evCfg.deltaFlip.timeframe) {
      const f = detectDeltaFlip(hist, evCfg.deltaFlip.avgLookback, evCfg.deltaFlip.minMultOfAvg);
      if (f) this.flips.push({ direction: f.direction, ts: c.ts + TF_MS[tf], detail: { tf, ...f } });
    }

    const dv = cfg.alerts.deltaDivergence;
    if (dv.timeframes.includes(tf)) {
      for (const d of detectDivergence(hist, dv.lookbackCandles)) {
        const direction: Direction = d.type === 'bullish' ? 'LONG' : 'SHORT';
        this.divs.push({ direction, ts: c.ts + TF_MS[tf], detail: d });
        if (!this.silent && dv.enabled && this.cooldown.tryFire(`div:${this.symbol}:${tf}:${d.type}`, now, dv.cooldownMs)) {
          this.emitAlert(now, 'delta_divergence', divergenceMessage(d), d);
        }
      }
    }

    // Prune stale events
    const cut = now - evCfg.conditionTtlMs;
    this.flips = this.flips.filter((e) => e.ts >= cut);
    this.divs = this.divs.filter((e) => e.ts >= cut);

    if (tf === '1m' && evCfg.enabled) this.evalDue = true;
  }

  private evaluateSignals(now: number): void {
    const sc = this.cfg.signals;
    const price = this.lastPrice;
    const htfHist = this.builders.get(sc.htf.timeframe)!.history;
    const ctx = {
      symbol: this.symbol, ts: now, price, atr: this.atr.value, near: this.nearDistance(price),
      profile: this.snapshot(now), flips: this.flips, divergences: this.divs,
      bigTrades: this.bigBuf.recent(now),
      htfZ: htfDeltaZ(htfHist, sc.htf.lookbackCandles, sc.htf.historyCandles, sc.htf.minHistory),
    };
    for (const dir of ['LONG', 'SHORT'] as const) {
      const ev = evaluateDirection(sc, ctx, dir);
      if (!ev.ok) {
        // Count only near-misses (at least 2 conditions) to keep the stats meaningful.
        if (ev.conditions.length >= 2) this.stats.rejected[ev.reason] = (this.stats.rejected[ev.reason] ?? 0) + 1;
        continue;
      }
      if (!this.cooldown.tryFire(`sig:${this.symbol}:${dir}`, now, sc.cooldownMs)) {
        this.stats.rejected.cooldown = (this.stats.rejected.cooldown ?? 0) + 1;
        continue;
      }
      this.emitSignal(ev.candidate);
    }
  }

  private emitSignal(c: Candidate): void {
    const id = this.deps.store.insertSignal({
      ts: c.ts, symbol: c.symbol, direction: c.direction, score: c.score, entry: c.entry,
      entryLo: c.entryLo, entryHi: c.entryHi, stop: c.stop, t1: c.t1, t2: c.t2,
      rr: c.rr, rrT1: c.rrT1, rrT2: c.rrT2, atr: c.atr,
      inputs: { ...c.inputs, t2Synthetic: c.t2Synthetic },
      conditions: c.conditions,
    });
    this.tracker.add({ id, symbol: c.symbol, direction: c.direction, ts: c.ts, entry: c.entry, stop: c.stop, t1: c.t1, t2: c.t2 });
    this.stats.signals++;
    this.deps.notifier.send(signalMessage(c, id));
    this.deps.log?.(`signal #${id} ${c.symbol} ${c.direction} score=${c.score}`);
  }
}
