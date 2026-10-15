import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
// server.js is dense one-liners. A trailing // comment in the middle of a line silently comments out the code after it
// (this has bitten us twice), so no line may contain a // comment followed by more code on the same line.
test("server.js has no // comment that swallows code on the same line", () => {
  const bad = [];
  fs.readFileSync(new URL("../server.js", import.meta.url), "utf8").split("\n").forEach((line, i) => {
    const m = line.match(/(^|[;{})\s])\/\/(?!\/)([^"'`]*)$/); // a // outside strings
    if (!m) return;
    if (/(\)return;|\bconst\b|\bfor\(|\bif\(|\w+\([^)]*\);)/.test(m[2]) && /\b(if|const|for|return)\b.*[;{]/.test(m[2])) bad.push(`line ${i + 1}: ${line.slice(0, 120)}`);
  });
  assert.deepEqual(bad, []);
});
test("the pump.fun display filters and speed cap are live code", () => {
  const s = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const line = s.split("\n").find(l => l.startsWith("if(usd<1&&!pin)return;"));
  assert.ok(line, "filter line exists");
  assert.ok(!line.includes("//"), "no comment on the filter line");
  assert.ok(line.includes("now-last<35") && line.includes("st.pumpTrades++"));
});
