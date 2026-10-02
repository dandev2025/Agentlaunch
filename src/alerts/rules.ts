import type { BigTrade, Divergence, Level, LevelKind, ProfileSnapshot, WallEvent } from '../core/types.js';
import { fmtPrice, fmtTime, fmtUsd } from '../core/format.js';
import { esc } from './notifier.js';

export function profileLevels(p: ProfileSnapshot): Level[] {
  return [
    { kind: 'POC', price: p.poc },
    { kind: 'VAH', price: p.vah },
    { kind: 'VAL', price: p.val },
    ...p.hvns.map((h) => ({ kind: 'HVN' as const, price: h.price, volume: h.volume })),
  ];
}

export interface BigTradeAlert {
  trade: BigTrade;
  level: Level;
  distance: number;
  near: number;
  message: string;
  inputs: Record<string, unknown>;
}

/** Big trade within `near` of a POC/HVN (or other configured kinds). Nearest level wins. */
export function bigTradeAtLevel(
  trade: BigTrade,
  profile: ProfileSnapshot,
  kinds: LevelKind[],
  near: number,
): BigTradeAlert | null {
  let best: Level | null = null;
  let bestDist = Infinity;
  for (const l of profileLevels(profile)) {
    if (!kinds.includes(l.kind)) continue;
    const d = Math.abs(trade.price - l.price);
    if (d <= near && d < bestDist) { best = l; bestDist = d; }
  }
  if (!best) return null;
  const msg =
    `🐋 <b>${esc(trade.symbol)}</b> big ${trade.side.toUpperCase()} at ${best.kind}\n` +
    `${trade.size} @ ${fmtPrice(trade.price)} (~$${fmtUsd(trade.notional)})\n` +
    `${best.kind} ${fmtPrice(best.price)} · distance ${fmtPrice(bestDist)} (limit ${fmtPrice(near)})\n` +
    `VAL ${fmtPrice(profile.val)} · POC ${fmtPrice(profile.poc)} · VAH ${fmtPrice(profile.vah)}\n` +
    fmtTime(trade.ts);
  return {
    trade, level: best, distance: bestDist, near, message: msg,
    inputs: { trade, level: best, distance: bestDist, near, profile },
  };
}

export function divergenceMessage(d: Divergence): string {
  const arrow = d.type === 'bullish' ? '🟢' : '🔴';
  return (
    `${arrow} <b>${esc(d.symbol)}</b> ${d.type} delta divergence (${d.tf})\n` +
    `${d.type === 'bullish' ? 'New low' : 'New high'} ${fmtPrice(d.price)} vs prior ${fmtPrice(d.refPrice)}\n` +
    `CVD ${d.cvd.toFixed(1)} vs ${d.refCvd.toFixed(1)} at prior extreme\n` +
    fmtTime(d.ts)
  );
}

export interface WallAlert {
  level: Level;
  distance: number;
  message: string;
  inputs: Record<string, unknown>;
}

/** A wall event (e.g. pulled / eaten) at or near a configured profile level. */
export function wallEventAtLevel(ev: WallEvent, profile: ProfileSnapshot, kinds: LevelKind[], near: number): WallAlert | null {
  let best: Level | null = null;
  let bestDist = Infinity;
  for (const l of profileLevels(profile)) {
    if (!kinds.includes(l.kind)) continue;
    const d = Math.abs(ev.wall.price - l.price);
    if (d <= near && d < bestDist) { best = l; bestDist = d; }
  }
  if (!best) return null;
  const w = ev.wall;
  const verb = ev.type === 'eaten' ? 'EATEN' : ev.type === 'pulled' ? 'PULLED' : ev.type.toUpperCase();
  const note =
    ev.type === 'pulled' ? (ev.detail.spoofLike ? 'cancelled quickly, never traded into (spoof-like)' : 'cancelled, not traded into')
    : ev.type === 'eaten' ? `${w.executed.toFixed(1)} traded into it` : '';
  const msg =
    `🧱 <b>${esc(ev.symbol)}</b> ${w.side} wall ${verb} at ${fmtPrice(w.price)}\n` +
    `peak ${w.peak.toFixed(1)} · lived ${Math.round(ev.detail.lifetimeMs / 1000)}s${note ? ` · ${note}` : ''}\n` +
    `near ${best.kind} ${fmtPrice(best.price)} (distance ${fmtPrice(bestDist)})\n` +
    fmtTime(ev.ts);
  return { level: best, distance: bestDist, message: msg, inputs: { event: ev, level: best, distance: bestDist, near, profile } };
}
