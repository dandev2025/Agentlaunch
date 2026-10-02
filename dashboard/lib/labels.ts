/** Pushes labels apart vertically so none overlap (they keep their order); used for the right-hand price labels. */
export function spreadLabels<T extends { y: number }>(items: T[], minGap: number, lo: number, hi: number): (T & { ly: number })[] {
  const s = [...items].sort((a, b) => a.y - b.y).map((it) => ({ ...it, ly: it.y }));
  for (let i = 0; i < s.length; i++) s[i].ly = Math.max(lo, i ? Math.max(s[i].y, s[i - 1].ly + minGap) : s[i].y);
  for (let i = s.length - 1; i >= 0; i--) {
    const limit = i === s.length - 1 ? hi : s[i + 1].ly - minGap;
    if (s[i].ly > limit) s[i].ly = limit;
  }
  return s;
}
