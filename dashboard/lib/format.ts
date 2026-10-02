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

export const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
export const num = (x: number | null | undefined, d = 2) => (x == null ? '–' : Number.isFinite(x) ? x.toFixed(d) : '∞');
export const signed = (x: number | null | undefined, d = 2) => (x == null ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(d)}`);
