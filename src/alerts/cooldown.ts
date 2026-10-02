/** Per-key cooldown driven by the caller's clock (trade time), so replay behaves like live. */
export class Cooldown {
  private last = new Map<string, number>();

  /** Returns true (and starts the cooldown) if the key is not cooling down. */
  tryFire(key: string, now: number, cooldownMs: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < cooldownMs) return false;
    this.last.set(key, now);
    return true;
  }
}
