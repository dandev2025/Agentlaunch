// pump.fun TradeEvent decoding (from "Program data:" log lines) and bonding-curve market stats.
export const TRADE = Buffer.from("bddb7fd34ee661ee", "hex");

export function parseTrade(b, b58) {
  if (!(b.length >= 97 && b.subarray(0, 8).equals(TRADE))) return null;
  const e = {
    mint: b58(b.subarray(8, 40)),
    sol: Number(b.readBigUInt64LE(40)) / 1e9,
    tok: Number(b.readBigUInt64LE(48)) / 1e6,
    buy: b[56] === 1,
    user: b58(b.subarray(57, 89)),
  };
  if (b.length >= 121) { e.vsol = Number(b.readBigUInt64LE(97)); e.vtok = Number(b.readBigUInt64LE(105)); e.rsol = Number(b.readBigUInt64LE(113)) }
  return e;
}

// Market cap = virtual price x the fixed 1B supply. Liquidity = SOL really sitting in the curve.
export function curveStats(e, solUsd) {
  if (!(e.vsol > 0 && e.vtok > 0) || !(solUsd > 0)) return { mc: null, lq: null };
  return { mc: (e.vsol / e.vtok) * 1e6 * solUsd, lq: Number.isFinite(e.rsol) ? (e.rsol / 1e9) * solUsd : null };
}

// How far a pump.fun bonding curve has filled: real SOL in the curve over the ~85 SOL needed to graduate.
export const GRAD_SOL = 85;
export function curveProgress(e) {
  if (!Number.isFinite(e.rsol) || e.rsol < 0) return null;
  return Math.max(0, Math.min(1, e.rsol / 1e9 / GRAD_SOL));
}
