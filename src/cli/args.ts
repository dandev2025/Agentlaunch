import { parseArgs } from 'node:util';

export function cli<T extends Record<string, { type: 'string' | 'boolean'; short?: string }>>(options: T) {
  return parseArgs({ options, allowPositionals: false }).values as unknown as Record<keyof T, string | boolean | undefined>;
}

export function parseTime(v: string | boolean | undefined): number | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`Cannot parse time "${v}" (use ISO like 2026-01-01T00:00:00Z or epoch ms)`);
  return ms;
}
