import type { GexSnapshot, GexStrike } from '../core/types.js';

/** One row of Deribit's get_book_summary_by_currency (only the fields used here). */
export interface BookSummaryRow {
  instrument_name: string;
  mark_iv?: number | null; // percent
  open_interest?: number | null; // underlying units (1 contract = 1 coin)
  underlying_price?: number | null; // forward for that expiry
  estimated_delivery_price?: number | null; // index price
}

export interface GexOptions {
  minHoursToExpiry: number;
  maxDaysToExpiry: number;
  /** Search ±gridPct around spot for the flip level, in steps of gridStepPct. */
  gridPct: number;
  gridStepPct: number;
}

export interface ParsedInstrument {
  currency: string;
  expiryTs: number;
  strike: number;
  type: 'C' | 'P';
}

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** `BTC-27JUN25-100000-C` -> expiry 08:00 UTC that day (Deribit's expiry time). `d` is the decimal point in strikes (`0d5`). */
export function parseInstrument(name: string): ParsedInstrument | null {
  const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-([\dd]+)-([CP])$/.exec(name);
  if (!m || !(m[3] in MONTHS)) return null;
  const strike = Number(m[5].replace('d', '.'));
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { currency: m[1], expiryTs: Date.UTC(2000 + Number(m[4]), MONTHS[m[3]], Number(m[2]), 8, 0, 0), strike, type: m[6] as 'C' | 'P' };
}

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Black-Scholes gamma on the forward measure (r = 0): phi(d1) / (F x sigma x sqrt(T)). Same for calls and puts. */
export function bsGamma(forward: number, strike: number, tYears: number, sigma: number): number {
  if (!(forward > 0 && strike > 0 && tYears > 0 && sigma > 0)) return 0;
  const sd = sigma * Math.sqrt(tYears);
  const d1 = (Math.log(forward / strike) + 0.5 * sd * sd) / sd;
  return Math.exp(-0.5 * d1 * d1) / SQRT_2PI / (forward * sd);
}

interface Opt {
  strike: number;
  sign: 1 | -1;
  oi: number;
  forward: number;
  t: number;
  iv: number;
}

const YEAR_MS = 365 * 86_400_000;

/**
 * Net dealer gamma exposure from open interest, using the common convention that dealers are long
 * the calls and short the puts customers hold: calls count +, puts -. Units: dollars of delta per 1% move,
 * OI x gamma x F^2 x 0.01. It is an *estimate* — real dealer positioning is not observable from OI.
 *
 * The flip level is found by re-evaluating total GEX with every forward scaled by m (a hypothetical
 * spot move), keeping OI and IV fixed, and taking the sign change closest to the current spot.
 */
export function computeGex(underlying: string, rows: BookSummaryRow[], now: number, o: GexOptions): GexSnapshot | null {
  const opts: Opt[] = [];
  const fwds: number[] = [];
  const idx: number[] = [];
  for (const r of rows) {
    const p = parseInstrument(r.instrument_name);
    if (!p || p.currency !== underlying) continue;
    const hours = (p.expiryTs - now) / 3_600_000;
    if (hours < o.minHoursToExpiry || hours > o.maxDaysToExpiry * 24) continue;
    const oi = Number(r.open_interest), iv = Number(r.mark_iv) / 100, fwd = Number(r.underlying_price);
    if (!(oi > 0 && iv > 0 && fwd > 0)) continue;
    opts.push({ strike: p.strike, sign: p.type === 'C' ? 1 : -1, oi, forward: fwd, t: (p.expiryTs - now) / YEAR_MS, iv });
    fwds.push(fwd);
    if (r.estimated_delivery_price && r.estimated_delivery_price > 0) idx.push(r.estimated_delivery_price);
  }
  if (!opts.length) return null;
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const spot = idx.length ? median(idx) : median(fwds);

  const totalAt = (m: number): number => {
    let s = 0;
    for (const x of opts) {
      const f = x.forward * m;
      s += x.sign * x.oi * bsGamma(f, x.strike, x.t, x.iv) * f * f * 0.01;
    }
    return s;
  };

  // per-strike breakdown at the current spot
  const byStrike = new Map<number, GexStrike>();
  for (const x of opts) {
    const g = x.sign * x.oi * bsGamma(x.forward, x.strike, x.t, x.iv) * x.forward * x.forward * 0.01;
    const s = byStrike.get(x.strike) ?? { strike: x.strike, callGex: 0, putGex: 0, gex: 0, oi: 0 };
    if (x.sign > 0) s.callGex += g; else s.putGex += g;
    s.gex += g;
    s.oi += x.oi;
    byStrike.set(x.strike, s);
  }
  const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  const total = totalAt(1);

  // flip: nearest sign change on the grid, linearly interpolated
  let flipM: number | null = null;
  let best = Infinity;
  const steps = Math.round(o.gridPct / o.gridStepPct);
  let prevM = 1 - o.gridPct, prevG = totalAt(prevM);
  for (let i = 1; i <= 2 * steps; i++) {
    const m = 1 - o.gridPct + i * o.gridStepPct;
    const g = totalAt(m);
    if (prevG !== 0 && Math.sign(prevG) !== Math.sign(g)) {
      const x = prevM + ((m - prevM) * (0 - prevG)) / (g - prevG);
      if (Math.abs(x - 1) < best) { best = Math.abs(x - 1); flipM = x; }
    }
    prevM = m; prevG = g;
  }

  return {
    underlying, ts: now, spot, flipLevel: flipM == null ? null : spot * flipM, totalGex: total,
    strikes, instruments: opts.length,
  };
}
