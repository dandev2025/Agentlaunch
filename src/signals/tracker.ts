import type { Direction } from '../core/types.js';
import type { SignalUpdate } from '../db/store.js';

export interface TrackedSignal {
  id: number;
  symbol: string;
  direction: Direction;
  ts: number;
  entry: number;
  stop: number;
  t1: number;
  t2: number;
  t1Hit?: boolean;
}

interface State extends TrackedSignal {
  mfe: number;
  mae: number;
  t1Ts: number | null;
}

export interface TrackerOptions {
  maxHoldMs: number;
  /** Fraction of the position closed at T1; the rest runs to T2 (or the original stop). */
  t1Fraction: number;
}

/**
 * Tracks open signals trade-by-trade. Because trades arrive sequentially, a stop and a
 * target can never be "hit in the same bar" — the order is known exactly.
 *
 * Realised R: STOP before T1 = -1R. After T1, f x R(T1) is banked and the rest runs:
 * T2 => f x R1 + (1-f) x R2, stop => f x R1 - (1-f). Expiry marks the remainder to market.
 */
export class SignalTracker {
  private open = new Map<number, State>();

  constructor(private opts: TrackerOptions, private persist: (id: number, u: SignalUpdate) => void) {}

  get openCount(): number {
    return this.open.size;
  }

  add(s: TrackedSignal): void {
    this.open.set(s.id, { ...s, mfe: 0, mae: 0, t1Ts: s.t1Hit ? s.ts : null });
  }

  onPrice(symbol: string, ts: number, price: number): void {
    for (const s of this.open.values()) {
      if (s.symbol !== symbol || ts < s.ts) continue;
      const sg = s.direction === 'LONG' ? 1 : -1;
      const risk = (s.entry - s.stop) * sg;
      const move = (price - s.entry) * sg;
      s.mfe = Math.max(s.mfe, move);
      s.mae = Math.max(s.mae, -move);
      const r1 = ((s.t1 - s.entry) * sg) / risk;
      const r2 = ((s.t2 - s.entry) * sg) / risk;
      const f = this.opts.t1Fraction;

      if ((price - s.stop) * sg <= 0) {
        this.close(s, ts, s.t1Ts != null ? 'T1' : 'STOP', s.t1Ts != null ? f * r1 - (1 - f) : -1, { stopTs: ts });
      } else if ((price - s.t2) * sg >= 0) {
        if (s.t1Ts == null) s.t1Ts = ts;
        this.close(s, ts, 'T2', f * r1 + (1 - f) * r2, { t2Ts: ts });
      } else if (s.t1Ts == null && (price - s.t1) * sg >= 0) {
        s.t1Ts = ts;
        this.persist(s.id, this.update(s, { t1Ts: ts }));
      } else if (ts - s.ts > this.opts.maxHoldMs) {
        const rNow = move / risk;
        this.close(s, ts, 'EXPIRED', s.t1Ts != null ? f * r1 + (1 - f) * rNow : rNow, {});
      }
    }
  }

  private update(s: State, extra: Partial<SignalUpdate>): SignalUpdate {
    const risk = Math.abs(s.entry - s.stop);
    return {
      maxFavorable: s.mfe, maxAdverse: s.mae, maxFavorableR: s.mfe / risk, maxAdverseR: s.mae / risk,
      closed: false, ...extra,
    };
  }

  private close(s: State, ts: number, outcome: string, realizedR: number, extra: Partial<SignalUpdate>): void {
    this.persist(s.id, this.update(s, { ...extra, t1Ts: s.t1Ts, closedTs: ts, outcome, realizedR, closed: true }));
    this.open.delete(s.id);
  }

  /** Persist current MFE/MAE of everything still open (call on shutdown / replay end). */
  flush(): void {
    for (const s of this.open.values()) this.persist(s.id, this.update(s, { t1Ts: s.t1Ts }));
  }
}
