import type { ProfileSnapshot } from '../core/types.js';

export interface VolumeProfileOptions {
  binSize: number;
  windowMs: number;
  valueAreaPct: number;
  hvnFactor: number;
  hvnMinSepBins: number;
  hvnSmoothBins: number;
}

/**
 * Rolling volume profile. Volume is stored in one-minute slices so old data can be
 * evicted cheaply. Prices are binned to `binSize`; a bin's price label is index*binSize.
 */
export class VolumeProfile {
  private slices = new Map<number, Map<number, number>>(); // minute -> bin -> volume
  private agg = new Map<number, number>();
  private total = 0;
  private latest = 0;

  constructor(private o: VolumeProfileOptions) {}

  binOf(price: number): number {
    return Math.round(price / this.o.binSize);
  }

  add(ts: number, price: number, size: number): void {
    const minute = Math.floor(ts / 60_000);
    const bin = this.binOf(price);
    let s = this.slices.get(minute);
    if (!s) this.slices.set(minute, (s = new Map()));
    s.set(bin, (s.get(bin) ?? 0) + size);
    this.agg.set(bin, (this.agg.get(bin) ?? 0) + size);
    this.total += size;
    if (ts > this.latest) this.latest = ts;
    this.evict(ts);
  }

  private evict(now: number): void {
    const cutMinute = Math.floor((now - this.o.windowMs) / 60_000);
    for (const [m, s] of this.slices) {
      if (m >= cutMinute) break; // Map preserves insertion order; minutes arrive ascending
      for (const [bin, v] of s) {
        const left = (this.agg.get(bin) ?? 0) - v;
        if (left <= 1e-9) this.agg.delete(bin);
        else this.agg.set(bin, left);
        this.total -= v;
      }
      this.slices.delete(m);
    }
  }

  get totalVolume(): number {
    return this.total;
  }

  snapshot(now = this.latest): ProfileSnapshot | null {
    this.evict(now);
    if (this.agg.size === 0 || this.total <= 0) return null;
    const { binSize, valueAreaPct, hvnFactor, hvnMinSepBins, hvnSmoothBins } = this.o;

    let minBin = Infinity, maxBin = -Infinity;
    for (const b of this.agg.keys()) {
      if (b < minBin) minBin = b;
      if (b > maxBin) maxBin = b;
    }
    const n = maxBin - minBin + 1;
    const v = new Float64Array(n);
    for (const [b, vol] of this.agg) v[b - minBin] = vol;

    // POC: highest-volume bin (ties -> lowest price)
    let poc = 0;
    for (let i = 1; i < n; i++) if (v[i] > v[poc]) poc = i;

    // Value area: grow from the POC, adding the heavier pair of adjacent bins each step.
    const target = this.total * valueAreaPct;
    let lo = poc, hi = poc, acc = v[poc];
    while (acc < target && (lo > 0 || hi < n - 1)) {
      const up = (hi + 1 < n ? v[hi + 1] : 0) + (hi + 2 < n ? v[hi + 2] : 0);
      const dn = (lo - 1 >= 0 ? v[lo - 1] : 0) + (lo - 2 >= 0 ? v[lo - 2] : 0);
      if ((up >= dn && hi < n - 1) || lo === 0) {
        for (let k = 1; k <= 2 && hi + 1 < n; k++) acc += v[++hi];
      } else {
        for (let k = 1; k <= 2 && lo - 1 >= 0; k++) acc += v[--lo];
      }
    }

    // HVNs: local maxima of the smoothed profile that stand out from the average bin.
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -hvnSmoothBins; k <= hvnSmoothBins; k++) {
        if (i + k >= 0 && i + k < n) { s += v[i + k]; c++; }
      }
      sm[i] = s / c;
    }
    const nonZero = this.agg.size;
    const mean = this.total / nonZero;
    const hvns: { price: number; volume: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (i === poc || sm[i] < hvnFactor * mean) continue;
      let peak = true;
      for (let k = 1; k <= hvnMinSepBins && peak; k++) {
        if (i - k >= 0 && sm[i - k] > sm[i]) peak = false; // left: ties allowed
        if (i + k < n && sm[i + k] >= sm[i]) peak = false; // right: strict, so plateaus yield one node
      }
      if (peak) hvns.push({ price: (i + minBin) * binSize, volume: v[i] });
    }

    return {
      ts: now,
      poc: (poc + minBin) * binSize,
      val: (lo + minBin) * binSize,
      vah: (hi + minBin) * binSize,
      hvns,
      totalVolume: this.total,
      binSize,
    };
  }
}
