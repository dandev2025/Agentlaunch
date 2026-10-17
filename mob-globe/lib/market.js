// Picks the most liquid Solana pair from a DexScreener tokens response and flattens it for the page.
export function pickPair(json, mint) {
  const pairs = (json && Array.isArray(json.pairs) ? json.pairs : []).filter(p => p && p.chainId === "solana" && p.baseToken && p.baseToken.address === mint);
  if (!pairs.length) return null;
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = pairs[0], n = v => (Number.isFinite(+v) ? +v : null);
  return {
    pair: String(p.pairAddress || ""),
    dex: String(p.dexId || ""),
    price: n(p.priceUsd),
    mc: n(p.marketCap ?? p.fdv),
    fdv: n(p.fdv),
    liq: n(p.liquidity?.usd),
    vol24: n(p.volume?.h24),
    vol1h: n(p.volume?.h1),
    chg5m: n(p.priceChange?.m5),
    chg1h: n(p.priceChange?.h1),
    chg24: n(p.priceChange?.h24),
    created: n(p.pairCreatedAt),
    url: typeof p.url === "string" && p.url.startsWith("https://dexscreener.com/") ? p.url : "",
  };
}
