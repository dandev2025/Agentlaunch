import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeFilter, passes } from "../lib/filter.js";
import { parseTrade, curveStats, TRADE } from "../lib/pump.js";

const ev = (o = {}) => ({ usd: 500, buy: true, venue: "pump.fun", mc: 20000, lq: 4000, age: 120, ...o });

test("no filter lets everything through", () => {
  assert.equal(sanitizeFilter(null), null);
  assert.equal(sanitizeFilter({}), null);
  assert.equal(passes(null, ev()), true);
});
test("market cap and liquidity bounds", () => {
  const f = sanitizeFilter({ mcMin: 10000, mcMax: 50000, lqMin: 3000 });
  assert.equal(passes(f, ev()), true);
  assert.equal(passes(f, ev({ mc: 5000 })), false);
  assert.equal(passes(f, ev({ mc: 90000 })), false);
  assert.equal(passes(f, ev({ lq: 1000 })), false);
  assert.equal(passes(f, ev({ mc: null })), false);
  assert.equal(passes(f, ev({ lq: null })), false);
});
test("age: newer-than treats unknown age as old, older-than lets unknown through", () => {
  const f = sanitizeFilter({ ageMax: 15 });
  assert.equal(passes(f, ev({ age: 300 })), true);
  assert.equal(passes(f, ev({ age: 1200 })), false);
  assert.equal(passes(f, ev({ age: null })), false);
  const g = sanitizeFilter({ ageMin: 60 });
  assert.equal(passes(g, ev({ age: 30 })), false);
  assert.equal(passes(g, ev({ age: 7200 })), true);
  assert.equal(passes(g, ev({ age: null })), true);
});
test("side, size and venue", () => {
  const f = sanitizeFilter({ side: "buy", minUsd: 1000, venues: ["Raydium"] });
  assert.equal(passes(f, ev({ usd: 2000, venue: "Raydium" })), true);
  assert.equal(passes(f, ev({ usd: 2000, venue: "pump.fun" })), false);
  assert.equal(passes(f, ev({ usd: 2000, venue: "Raydium", buy: false })), false);
  assert.equal(passes(f, ev({ usd: 500, venue: "Raydium" })), false);
});
test("sanitize drops junk", () => {
  const f = sanitizeFilter({ mcMin: "abc", mcMax: -5, venues: ["ok", 7, "x".repeat(40)], side: "hax" });
  assert.deepEqual(f, { mcMin: null, mcMax: null, lqMin: null, lqMax: null, ageMax: null, ageMin: null, minUsd: null, side: null, venues: ["ok"] });
  assert.equal(sanitizeFilter({ mcMin: "abc" }), null);
});
test("decodes a pump.fun trade event and its curve stats", () => {
  const b = Buffer.alloc(129);
  TRADE.copy(b, 0);
  b.fill(7, 8, 40);
  b.writeBigUInt64LE(500000000n, 40);          // 0.5 SOL
  b.writeBigUInt64LE(17000000000000n, 48);     // 17M tokens (6 decimals)
  b[56] = 1;
  b.fill(9, 57, 89);
  b.writeBigUInt64LE(30000000000n, 97);        // virtual SOL 30
  b.writeBigUInt64LE(1073000000000000n, 105);  // virtual tokens 1.073B
  b.writeBigUInt64LE(2000000000n, 113);        // real SOL 2
  const e = parseTrade(b, u => "k" + u[0]);
  assert.equal(e.mint, "k7"); assert.equal(e.user, "k9");
  assert.equal(e.sol, 0.5); assert.equal(e.tok, 17000000); assert.equal(e.buy, true);
  const s = curveStats(e, 150);
  assert.ok(Math.abs(s.mc - 4194) < 5, "mc " + s.mc);   // ~28 SOL x $150
  assert.equal(s.lq, 300);                              // 2 SOL x $150
  assert.equal(parseTrade(Buffer.alloc(50), u => "x"), null);
  assert.deepEqual(curveStats({ vsol: 0, vtok: 0 }, 150), { mc: null, lq: null });
});
