import test from "node:test";
import assert from "node:assert/strict";
import { pickPair } from "../lib/market.js";

const M = "So11111111111111111111111111111111111111112";
test("picks the most liquid solana pair for the mint", () => {
  const r = pickPair({ pairs: [
    { chainId: "solana", pairAddress: "a", baseToken: { address: M }, liquidity: { usd: 10 }, priceUsd: "1.5" },
    { chainId: "solana", pairAddress: "b", baseToken: { address: M }, liquidity: { usd: 99 }, priceUsd: "2", marketCap: 5000, volume: { h24: 12 }, url: "https://dexscreener.com/solana/b" },
    { chainId: "ethereum", pairAddress: "c", baseToken: { address: M }, liquidity: { usd: 999 } },
  ] }, M);
  assert.equal(r.pair, "b");
  assert.equal(r.price, 2);
  assert.equal(r.mc, 5000);
  assert.equal(r.vol24, 12);
  assert.equal(r.url, "https://dexscreener.com/solana/b");
});
test("returns null when there is no pair", () => {
  assert.equal(pickPair({ pairs: null }, M), null);
  assert.equal(pickPair({}, M), null);
});
test("ignores a url that is not dexscreener", () => {
  const r = pickPair({ pairs: [{ chainId: "solana", pairAddress: "a", baseToken: { address: M }, url: "https://evil.example/x" }] }, M);
  assert.equal(r.url, "");
});
