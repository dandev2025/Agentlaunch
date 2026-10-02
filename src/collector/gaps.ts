import type { Side, Trade } from '../core/types.js';

export interface Gap {
  fromId: number;
  toId: number;
  missing: number;
}

/** aggTrade ids are consecutive per symbol; any jump means we missed trades. */
export class GapDetector {
  private last = new Map<string, number>();

  seed(symbol: string, lastAggId: number | null): void {
    if (lastAggId != null) this.last.set(symbol, lastAggId);
  }

  /** Records the id and returns the gap that preceded it, if any. Duplicates/old ids return null. */
  check(symbol: string, aggId: number): Gap | null {
    const prev = this.last.get(symbol);
    if (prev !== undefined && aggId <= prev) return null;
    this.last.set(symbol, aggId);
    if (prev === undefined || aggId === prev + 1) return null;
    return { fromId: prev + 1, toId: aggId - 1, missing: aggId - prev - 1 };
  }
}

export type FetchJson = (url: string) => Promise<any>;
const defaultFetchJson: FetchJson = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
};

const fromRest = (symbol: string, r: any): Trade => ({
  symbol, aggId: Number(r.a), ts: Number(r.T), price: Number(r.p), size: Number(r.q), side: (r.m ? 'sell' : 'buy') as Side,
});

/** Page through REST /fapi/v1/aggTrades from `fromId` up to and including `toId`. */
export async function fetchAggTradesRange(
  restBase: string,
  symbol: string,
  fromId: number,
  toId: number,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<Trade[]> {
  const out: Trade[] = [];
  let next = fromId;
  while (next <= toId) {
    const rows: any[] = await fetchJson(`${restBase}/fapi/v1/aggTrades?symbol=${symbol}&fromId=${next}&limit=1000`);
    if (!rows.length) break;
    for (const r of rows) {
      if (Number(r.a) > toId) return out;
      out.push(fromRest(symbol, r));
    }
    next = Number(rows[rows.length - 1].a) + 1;
  }
  return out;
}

/** Page through aggTrades by time window (used by the backfill CLI). */
export async function fetchAggTradesByTime(
  restBase: string,
  symbol: string,
  startMs: number,
  endMs: number,
  onPage: (trades: Trade[]) => void,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<number> {
  let total = 0;
  let url = `${restBase}/fapi/v1/aggTrades?symbol=${symbol}&startTime=${startMs}&endTime=${Math.min(endMs, startMs + 3_600_000)}&limit=1000`;
  let cursor = startMs;
  for (;;) {
    const rows: any[] = await fetchJson(url);
    if (!rows.length) {
      // Empty window: skip ahead an hour (API limits startTime..endTime to 1h).
      cursor += 3_600_000;
      if (cursor >= endMs) break;
      url = `${restBase}/fapi/v1/aggTrades?symbol=${symbol}&startTime=${cursor}&endTime=${Math.min(endMs, cursor + 3_600_000)}&limit=1000`;
      continue;
    }
    const trades = rows.map((r) => fromRest(symbol, r)).filter((t) => t.ts <= endMs);
    onPage(trades);
    total += trades.length;
    const last = rows[rows.length - 1];
    if (Number(last.T) >= endMs || trades.length < rows.length) break;
    url = `${restBase}/fapi/v1/aggTrades?symbol=${symbol}&fromId=${Number(last.a) + 1}&limit=1000`;
  }
  return total;
}
