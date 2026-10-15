import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";

const mk = (over = {}) => {
  const calls = []; let t = Date.UTC(2026, 9, 15, 12, 0, 30), fail = false;
  const fetchFn = async (url, init) => { calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers }); return fail ? { ok: false, status: 503, text: async () => "down" } : { ok: true, status: 200, json: async () => [], text: async () => "[]" } };
  const s = createStore({ url: "https://x.supabase.co", key: "K", fetchFn, now: () => t, log: () => {}, ...over });
  return { s, calls, tick: ms => (t += ms), setFail: v => (fail = v) };
};
const tr = (o = {}) => ({ mint: "M1", sym: "$A", venue: "pump.fun", region: 0, buy: true, usd: 100, wallet: "W", sig: "s", bot: false, ...o });

test("disabled store does nothing and never calls the network", async () => {
  const { s, calls } = mk({ url: "", key: "" }); s.add(tr()); await s.flush(); assert.equal(calls.length, 0); assert.equal(s.enabled, false);
});
test("aggregates buys and sells into one row per minute/mint/venue/region", async () => {
  const { s, calls } = mk(); s.add(tr()); s.add(tr({ usd: 50 })); s.add(tr({ buy: false, usd: 30 })); s.add(tr({ region: 1 }));
  await s.flush(); const rows = calls.find(c => c.url.includes("flow_minute")).body;
  assert.equal(rows.length, 2); const r0 = rows.find(r => r.region === 0);
  assert.deepEqual([r0.buy_usd, r0.sell_usd, r0.trades], [150, 30, 3]); assert.equal(r0.bucket, "2026-10-15T12:00:00.000Z");
});
test("uses service key headers and upsert conflict target", async () => {
  const { s, calls } = mk(); s.add(tr()); await s.flush(); const c = calls[0];
  assert.match(c.url, /rest\/v1\/flow_minute\?on_conflict=bucket,mint,venue,region$/); assert.equal(c.headers.apikey, "K"); assert.match(c.headers.prefer, /merge-duplicates/);
});
test("only trades >= $5k go to big_trades, deduped by signature on the server", async () => {
  const { s, calls } = mk(); s.add(tr({ usd: 4999, sig: "a" })); s.add(tr({ usd: 5000, sig: "b", buy: false })); await s.flush();
  const c = calls.find(x => x.url.includes("big_trades")); assert.equal(c.body.length, 1); assert.equal(c.body[0].side, "sell"); assert.match(c.headers.prefer, /ignore-duplicates/); assert.match(c.url, /on_conflict=sig/);
});
test("a failed flush keeps data, backs off, then retries and sends the same totals", async () => {
  const { s, calls, tick, setFail } = mk(); s.add(tr()); setFail(true); await s.flush(); assert.equal(s.stat.failures, 1); assert.equal(s.pending().buckets, 1);
  const n = calls.length; await s.flush(); assert.equal(calls.length, n, "backoff: no call before retry time");
  setFail(false); tick(11000); await s.flush(); const last = calls.filter(c => c.url.includes("flow_minute")).at(-1); assert.equal(last.body[0].buy_usd, 100);
});
test("old minute buckets are dropped after a successful flush, current one is kept", async () => {
  const { s, tick } = mk(); s.add(tr()); await s.flush(); assert.equal(s.pending().buckets, 1); tick(5 * 60000); await s.flush(); assert.equal(s.pending().buckets, 0);
});
test("re-flushing the same minute sends the running total (overwrite, never double count)", async () => {
  const { s, calls } = mk(); s.add(tr()); await s.flush(); s.add(tr()); await s.flush();
  const sent = calls.filter(c => c.url.includes("flow_minute")).map(c => c.body[0].buy_usd); assert.deepEqual(sent, [100, 200]);
});
test("wallet stats are batched and cleared once written", async () => {
  const { s, calls } = mk(); s.wallet("W1", { n: 3, ll: [-1.23456789, -2, -3], hrs: 5, bot: false }); await s.flush();
  const c = calls.find(x => x.url.includes("wallet_stats")); assert.equal(c.body[0].hours_mask, 5); assert.deepEqual(c.body[0].ll, [-1.2346, -2, -3]); assert.equal(s.pending().wallets, 0);
});
test("flow() asks for hourly buckets for 24h and daily for 7d, rejects unknown ranges", async () => {
  const { s, calls } = mk(); await s.flow("24h"); await s.flow("7d");
  assert.equal(calls[0].body.unit, "hour"); assert.equal(calls[1].body.unit, "day"); await assert.rejects(() => s.flow("1y"));
});
test("a key pasted into the URL field turns history off with a clear message", async () => {
  const msgs = []; const { s, calls } = mk({ url: "sb_publishable_abc", log: m => msgs.push(m) }); s.add(tr()); await s.flush();
  assert.equal(s.enabled, false); assert.equal(calls.length, 0); assert.match(msgs[0], /Project URL/);
});
test("new-style sb_ keys go in apikey only, legacy JWT keys in both headers", async () => {
  const a = mk({ key: "sb_secret_x" }); a.s.add(tr()); await a.s.flush(); assert.equal(a.calls[0].headers.authorization, undefined); assert.equal(a.calls[0].headers.apikey, "sb_secret_x");
  const b = mk({ key: "eyJabc" }); b.s.add(tr()); await b.s.flush(); assert.equal(b.calls[0].headers.authorization, "Bearer eyJabc");
});
test("nothing is counted before the launch date, counting starts after it", async () => {
  const early = mk({ launch: Date.UTC(2026, 9, 16) }); early.s.add(tr()); await early.s.flush(); assert.equal(early.calls.length, 0);
  const late = mk({ launch: Date.UTC(2026, 9, 1) }); late.s.add(tr()); await late.s.flush(); assert.equal(late.calls.length > 0, true);
});
test("totals() sums the daily rows and passes the launch date as the start", async () => {
  const calls = []; const fetchFn = async (u, i) => { calls.push({ u, b: i?.body && JSON.parse(i.body) });
    const body = u.includes("flow_top") ? [{ mint: "M", sym: "$A", buy: "5", sell: "2", trades: 3 }] : [{ t: "d1", buy: "10", sell: "4", trades: 3 }, { t: "d2", buy: "1.5", sell: "0.5", trades: 2 }];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } };
  const s = createStore({ url: "https://x.supabase.co", key: "K", fetchFn, launch: Date.UTC(2026, 9, 16), log: () => {} });
  const r = await s.totals(); assert.deepEqual([r.buy, r.sell, r.trades], [11.5, 4.5, 5]); assert.equal(r.since, "2026-10-16T00:00:00.000Z"); assert.equal(r.top[0].sym, "$A");
  assert.equal(calls[0].b.since, "2026-10-16T00:00:00.000Z");
});
test("a wrong SUPABASE_URL that returns a web page gives a readable error, not a JSON crash", async () => {
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => "<!DOCTYPE html><html>Not the API</html>", json: async () => { throw new Error("Unexpected token <") } });
  const s = createStore({ url: "https://x.supabase.co", key: "K", fetchFn, log: () => {} });
  await assert.rejects(() => s.totals(), /not JSON \(wrong SUPABASE_URL\?\)/);
});
test("SUPABASE_URL pasted with /rest/v1/ on the end, or spaces, still hits the right address", async () => {
  for (const u of ["https://x.supabase.co/rest/v1/", "https://x.supabase.co/rest/v1", " https://x.supabase.co/ ", "https://x.supabase.co"]) {
    const { s, calls } = mk({ url: u }); s.add(tr()); await s.flush();
    assert.match(calls[0].url, /^https:\/\/x\.supabase\.co\/rest\/v1\/flow_minute\?/, u);
  }
});
