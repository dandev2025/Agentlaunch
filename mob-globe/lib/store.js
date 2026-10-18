// Batched Supabase writer for the relay. Talks to PostgREST with plain fetch (no extra dependency).
// Never throws into the trade path: a Supabase outage only delays writes (buffers are kept, capped, retried with backoff).
export function createStore({ url, key, fetchFn = fetch, now = Date.now, log = console.log, bigUsd = 5000, launch = 0 } = {}) {
  const cleanUrl = String(url || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, ""); // accepts the project URL with or without a pasted /rest/v1/ on the end
  const okUrl = /^https?:\/\/[^\s/]+/.test(cleanUrl);
  if (url && !okUrl) log("[db] SUPABASE_URL must be the Project URL like https://abcdefgh.supabase.co (history is OFF). Got something that is not a URL.");
  const enabled = !!(url && key && okUrl), base = enabled ? cleanUrl + "/rest/v1/" : "";
  const buckets = new Map(), bigs = [], dirty = new Map();
  const stat = { flushed: 0, failures: 0, lastError: "" };
  let nextTry = 0, failing = 0, busy = false;
  // legacy keys are JWTs (eyJ...) and go in both headers; new sb_secret_ keys are not JWTs and go in apikey only
  const hdr = extra => ({ apikey: key, ...(String(key).startsWith("eyJ") ? { authorization: "Bearer " + key } : {}), "content-type": "application/json", ...extra });
  async function call(path, init) {
    const r = await fetchFn(base + path, { ...init, signal: AbortSignal.timeout?.(10000) });
    if (!r.ok) throw new Error(`${path.split("?")[0]} ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
    return r;
  }
  const upsert = (table, rows, onConflict, ignore) => call(`${table}?on_conflict=${onConflict}`, {
    method: "POST", headers: hdr({ prefer: `resolution=${ignore ? "ignore" : "merge"}-duplicates,return=minimal` }), body: JSON.stringify(rows) });

  // t: {mint, sym, venue, region, buy(bool), usd, wallet, sig, bot}
  function add(t) {
    if (!enabled || !t.mint || !(t.usd > 0) || t.usd > 1e6 || now() < launch) return; // nothing is counted before the launch date
    const minute = Math.floor(now() / 60000) * 60000, venue = t.venue || "", k = `${minute}|${t.mint}|${venue}|${t.region}`;
    let b = buckets.get(k);
    if (!b) { b = { bucket: new Date(minute).toISOString(), mint: t.mint, sym: t.sym || null, venue, region: t.region, buy_usd: 0, sell_usd: 0, trades: 0, minute }; buckets.set(k, b) }
    b[t.buy ? "buy_usd" : "sell_usd"] += t.usd; b.trades++;
    if (buckets.size > 5000) buckets.delete(buckets.keys().next().value);
    if (t.usd >= bigUsd && t.sig) { bigs.push({ ts: new Date(now()).toISOString(), sig: t.sig, mint: t.mint, sym: t.sym || null, venue, side: t.buy ? "buy" : "sell", usd: t.usd, wallet: t.wallet || null, region: t.region, bot: !!t.bot }); if (bigs.length > 2000) bigs.shift() }
  }
  // e: {n, ll:[3], hrs, bot}
  function wallet(w, e) {
    if (!enabled) return;
    dirty.set(w, { wallet: w, n: e.n, hours_mask: e.hrs, ll: e.ll.map(v => +v.toFixed(4)), bot: !!e.bot, updated_at: new Date(now()).toISOString() });
    if (dirty.size > 5000) dirty.delete(dirty.keys().next().value);
  }
  async function flush() {
    if (!enabled || busy || now() < nextTry) return;
    busy = true;
    try {
      const rows = [...buckets.values()].map(({ minute, ...r }) => r), nb = bigs.length, wl = [...dirty.entries()].slice(0, 500);
      // flow rows carry the running total for their minute, so re-sending the current minute overwrites (never double counts)
      if (rows.length) await upsert("flow_minute", rows, "bucket,mint,venue,region");
      if (nb) await upsert("big_trades", bigs.slice(0, nb), "sig", true);
      if (wl.length) await upsert("wallet_stats", wl.map(([, v]) => v), "wallet");
      bigs.splice(0, nb); for (const [w, v] of wl) if (dirty.get(w) === v) dirty.delete(w);
      const cut = Math.floor(now() / 60000) * 60000 - 120000; for (const [k, b] of buckets) if (b.minute < cut) buckets.delete(k);
      stat.flushed += rows.length; failing = 0; nextTry = 0;
    } catch (e) {
      stat.failures++; stat.lastError = e.message; failing++; nextTry = now() + Math.min(60000, 5000 * 2 ** failing);
      log("[store] write failed, will retry:", e.message);
    } finally { busy = false }
  }
  // Parse JSON ourselves so a wrong SUPABASE_URL (which returns a web page) gives a readable error
  const parse = async (r, what) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`${what}: HTTP ${r.status} and not JSON (wrong SUPABASE_URL? calling host: ${new URL(base).host}): ${t.slice(0, 60).replace(/\s+/g, " ").replace(/</g, "‹").replace(/>/g, "›")}`); } };
  const get = async path => parse(await call(path, { headers: hdr({}) }), path.split("?")[0]);
  const arenaSave = rows => enabled ? upsert("arena_players", rows, "id") : Promise.resolve();
  const arenaLoad = async () => enabled ? await get("arena_players?select=id,name,equity,level,wins&order=equity.desc&limit=500") : [];
  return {
    enabled, add, wallet, flush, stat, arenaSave, arenaLoad, pending: () => ({ buckets: buckets.size, bigs: bigs.length, wallets: dirty.size }),
    loadTracked: async () => enabled ? (await get("tracked_wallets?select=addr&limit=200")).map(r => r.addr) : [],
    saveTracked: async addr => { if (enabled) await upsert("tracked_wallets", [{ addr }], "addr", true) },
    loadWallets: async (limit = 20000) => enabled ? await get(`wallet_stats?select=wallet,n,hours_mask,ll,bot&order=updated_at.desc&limit=${limit}`) : [],
    // Totals since the launch date (or since the first saved row when no launch date is set)
    totals: async () => {
      const since = new Date(launch || 0).toISOString();
      const rows = await parse(await call("rpc/flow_agg", { method: "POST", headers: hdr({}), body: JSON.stringify({ since, unit: "day" }) }), "rpc/flow_agg");
      const top = await parse(await call("rpc/flow_top", { method: "POST", headers: hdr({}), body: JSON.stringify({ since, n: 10 }) }), "rpc/flow_top");
      return { since: launch ? new Date(launch).toISOString() : null, firstData: rows[0]?.t || null,
        buy: rows.reduce((a, r) => a + +r.buy, 0), sell: rows.reduce((a, r) => a + +r.sell, 0), trades: rows.reduce((a, r) => a + +r.trades, 0),
        top: top.map(x => ({ mint: x.mint, sym: x.sym, buy: +x.buy, sell: +x.sell, trades: +x.trades })) };
    },
    flow: async range => {
      const hours = { "24h": 24, "7d": 168, "30d": 720 }[range]; if (!hours) throw new Error("bad range");
      const r = await call("rpc/flow_agg", { method: "POST", headers: hdr({}), body: JSON.stringify({ since: new Date(now() - hours * 3600e3).toISOString(), unit: range === "24h" ? "hour" : "day" }) });
      return (await parse(r, "rpc/flow_agg")).map(x => ({ t: x.t, buy: +x.buy, sell: +x.sell, trades: +x.trades }));
    },
  };
}
