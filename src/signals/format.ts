import type { Candidate } from './evaluate.js';
import { fmtPrice, fmtTime } from '../core/format.js';
import { esc } from '../alerts/notifier.js';

export function signalMessage(c: Candidate, id: number): string {
  const icon = c.direction === 'LONG' ? '🟢' : '🔴';
  const conds = c.conditions.map((k) => `• ${k.key} (+${k.points})`).join('\n');
  return (
    `${icon} <b>${c.direction} ${esc(c.symbol)}</b> · score ${c.score} · #${id}\n` +
    `${conds}\n` +
    `Entry zone ${fmtPrice(c.entryLo)} – ${fmtPrice(c.entryHi)} (now ${fmtPrice(c.entry)})\n` +
    `Stop ${fmtPrice(c.stop)} (ATR ${fmtPrice(c.atr)})\n` +
    `T1 ${fmtPrice(c.t1)} · T2 ${fmtPrice(c.t2)}${c.t2Synthetic ? ' (ATR-projected)' : ''}\n` +
    `R:R ${c.rrT1.toFixed(2)} (T1) / ${c.rrT2.toFixed(2)} (T2)\n` +
    `${fmtTime(c.ts)}\n<i>Signal only — no order placed.</i>`
  );
}
