export type SP = Promise<Record<string, string | string[] | undefined>>;
export const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v) || undefined;
export const int = (v: string | string[] | undefined, d: number, min = 1, max = 1e6): number => {
  const n = Number(first(v));
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.floor(n)) : d;
};
