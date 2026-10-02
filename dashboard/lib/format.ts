export { fmtPrice, fmtTime, fmtUsd } from '../../src/core/format.js';

export function ago(ms: number | null): string {
  if (ms == null) return '–';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Alerts are stored as Telegram HTML; show them as plain text. */
export function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** "$86,052.4": thousands separators, decimals scaled to the price (BTC 1, ETH 2, SOL 3). USDT is treated as ~US dollars. */
export function fmtDollar(p: number): string {
  const d = p >= 1000 ? 1 : p >= 100 ? 2 : p >= 1 ? 3 : 5;
  return `$${p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
export const num = (x: number | null | undefined, d = 2) => (x == null ? '–' : Number.isFinite(x) ? x.toFixed(d) : '∞');
export const signed = (x: number | null | undefined, d = 2) => (x == null ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(d)}`);
