import test from "node:test";
import assert from "node:assert/strict";
import { createArena, cleanName } from "../lib/arena.js";

const ok = (o = {}) => ({ id: "abcdefghijkl1", name: "Dan", equity: 12.5, level: 2, wins: 3, ...o });

test("accepts a valid score and ranks by equity", () => {
  const a = createArena();
  assert.ok(a.submit(ok()));
  assert.ok(a.submit(ok({ id: "zzzzzzzzzzzz2", name: "Ann", equity: 20 })));
  const t = a.top();
  assert.equal(t[0].name, "Ann");
  assert.equal(t[0].gain, 100);
  assert.equal(t.length, 2);
  assert.equal(t[0].id, undefined);
});
test("rejects bad ids and out of range values", () => {
  const a = createArena();
  for (const bad of [ok({ id: "x" }), ok({ equity: -1 }), ok({ equity: 5000 }), ok({ equity: NaN }), ok({ level: 0 }), ok({ level: 1.5 }), ok({ wins: -2 }), null])
    assert.equal(a.submit(bad), false);
  assert.equal(a.size(), 0);
});
test("cleans names", () => {
  assert.equal(cleanName("<b>Dan</b>"), "bDanb");
  assert.equal(cleanName(""), "Anon");
  assert.equal(cleanName("x".repeat(40)).length, 16);
});
test("flush saves dirty rows once and retries after a failure", async () => {
  let calls = 0, fail = true;
  const a = createArena({ save: async rows => { calls++; if (fail) throw new Error("x"); assert.equal(rows.length, 1) } });
  a.submit(ok());
  await a.flush();
  fail = false;
  await a.flush();
  await a.flush();
  assert.equal(calls, 2);
});
test("player cap", () => {
  const a = createArena({ max: 1 });
  assert.ok(a.submit(ok()));
  assert.equal(a.submit(ok({ id: "zzzzzzzzzzzz2" })), false);
  assert.ok(a.submit(ok({ equity: 3 })));
});
