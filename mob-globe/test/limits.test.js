import test from "node:test";
import assert from "node:assert/strict";
import { safeUrl, cleanSym, originAllowed, clientIp, createRateLimit, createConnLimit, backoff } from "../lib/limits.js";

test("same-site origin is allowed, other sites are blocked, missing origin is allowed", () => {
  assert.equal(originAllowed("https://mob.example.com", "mob.example.com"), true);
  assert.equal(originAllowed("https://evil.com", "mob.example.com"), false);
  assert.equal(originAllowed(undefined, "mob.example.com"), true);
  assert.equal(originAllowed("not a url", "mob.example.com"), false);
});
test("extra origins can be allowed by full origin or host", () => {
  assert.equal(originAllowed("https://other.app", "mob.example.com", ["https://other.app"]), true);
  assert.equal(originAllowed("https://other.app", "mob.example.com", ["other.app"]), true);
  assert.equal(originAllowed("https://x.app", "mob.example.com", ["https://other.app"]), false);
});
test("client ip is the visitor (first forwarded entry), not the shared platform proxy", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "1.2.3.4, 10.9.9.9" }, socket: { remoteAddress: "10.0.0.1" } }), "1.2.3.4");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "10.0.0.1" } }), "10.0.0.1");
  assert.equal(clientIp({ headers: { "x-forwarded-for": "6.6.6.6" }, socket: { remoteAddress: "10.0.0.1" } }, false), "10.0.0.1");
});
test("rate limit allows max per window then blocks, then resets", () => {
  let t = 0; const rl = createRateLimit({ max: 3, windowMs: 1000, now: () => t });
  assert.deepEqual([1, 2, 3, 4].map(() => rl.hit("a")), [true, true, true, false]); assert.equal(rl.hit("b"), true);
  t = 1000; assert.equal(rl.hit("a"), true);
});
test("connection limit caps per key and frees a slot on release (release twice is safe)", () => {
  const cl = createConnLimit(2); const a = cl.acquire("ip"), b = cl.acquire("ip");
  assert.ok(a && b); assert.equal(cl.acquire("ip"), null); a(); a(); assert.equal(cl.count("ip"), 1); assert.ok(cl.acquire("ip"));
});
test("backoff grows, caps at 30s, and jitters between 50% and 100%", () => {
  assert.equal(backoff(0, () => 1), 1000); assert.equal(backoff(2, () => 0), 2000); assert.equal(backoff(20, () => 1), 30000);
});
test("token names are cleaned so they cannot inject HTML into the page", () => {
  assert.equal(cleanSym("$bonk"), "$BONK"); assert.equal(cleanSym("<img src=x onerror=alert(1)>"), "$IMGSRCXONERROR");
  assert.ok(!/[<>"'&=]/.test(cleanSym("a\"b'c<d>&e=f"))); assert.equal(cleanSym("", "AbCdEf"), "$ABCD"); assert.equal(cleanSym(undefined, ""), "$?");
});
test("only public https hosts are fetched for logos and metadata", () => {
  for (const ok of ["https://ipfs.io/ipfs/abc", "https://images.pump.fun/x.png"]) assert.equal(safeUrl(ok), true, ok);
  for (const bad of ["http://ipfs.io/x", "https://127.0.0.1/x", "https://169.254.169.254/latest", "https://localhost/x", "https://metadata/x", "https://svc.internal/x", "https://[::1]/x", "https://a.com:8080/x", "https://u:p@a.com/x", "file:///etc/passwd", "garbage"]) assert.equal(safeUrl(bad), false, bad);
});
