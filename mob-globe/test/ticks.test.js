import test from "node:test";
import assert from "node:assert/strict";
import { createTicks } from "../lib/ticks.js";

test("records ticks and returns history in order", () => {
  let t = 1000;
  const k = createTicks({ now: () => t });
  k.rec("A", 0.5, 1, true); t += 10; k.rec("A", 0.6, 2, false);
  assert.deepEqual(k.hist("A"), [[1000, 0.5, 1, 1], [1010, 0.6, 2, 0]]);
});
test("rejects bad values", () => {
  const k = createTicks();
  for (const [p, s] of [[0, 1], [-1, 1], [NaN, 1], [1, 0], [1, Infinity]]) assert.equal(k.rec("A", p, s, true), null);
  assert.equal(k.size(), 0);
});
test("caps ticks per token and drops the oldest token", () => {
  let t = 0;
  const k = createTicks({ max: 3, mints: 2, now: () => ++t });
  for (let i = 0; i < 5; i++) k.rec("A", 1, 1, true);
  assert.equal(k.hist("A").length, 3);
  k.rec("B", 1, 1, true); k.rec("C", 1, 1, true);
  assert.equal(k.size(), 2);
  assert.deepEqual(k.hist("A"), []);
});
test("drops ticks older than the ttl", () => {
  let t = 0;
  const k = createTicks({ ttl: 100, now: () => t });
  k.rec("A", 1, 1, true); t = 500; k.rec("A", 2, 1, true);
  assert.equal(k.hist("A").length, 1);
});
