import type { Config } from '../config/types.js';
import type { GexSnapshot, GexSource, GexView } from '../core/types.js';
import type { Store } from '../db/store.js';
import { computeGex, type BookSummaryRow } from '../indicators/gex.js';
import type { FetchJson } from './gaps.js';

const defaultFetchJson: FetchJson = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
};

/** Deribit public API (no key needed): every option's open interest and mark IV for one currency. */
export async function fetchBookSummary(baseUrl: string, currency: string, fetchJson: FetchJson = defaultFetchJson): Promise<BookSummaryRow[]> {
  const body = await fetchJson(`${baseUrl.replace(/\/$/, '')}/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`);
  if (body?.error) throw new Error(`Deribit error ${body.error.code}: ${body.error.message}`);
  if (!Array.isArray(body?.result)) throw new Error('unexpected Deribit response (no result array)');
  return body.result as BookSummaryRow[];
}

export interface GexServiceOptions {
  fetchJson?: FetchJson;
  now?: () => number;
  log?: (m: string) => void;
}

/** Polls Deribit on a timer, computes GEX per underlying, persists snapshots, and serves the latest to the engine. */
export class GexService implements GexSource {
  private latest = new Map<string, GexSnapshot>(); // by currency
  private timer: NodeJS.Timeout | null = null;
  private now: () => number;
  private log: (m: string) => void;
  failures = 0;

  constructor(private cfg: Config, private store: Store, private o: GexServiceOptions = {}) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[gex] ${m}`));
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.cfg.gex.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One refresh of every configured underlying. A failed fetch keeps the previous snapshot (which then ages out). */
  async poll(): Promise<void> {
    const g = this.cfg.gex;
    for (const cur of new Set(Object.values(g.underlyings))) {
      try {
        const rows = await fetchBookSummary(g.baseUrl, cur, this.o.fetchJson);
        const snap = computeGex(cur, rows, this.now(), g);
        if (!snap) throw new Error(`no usable ${cur} options in response (${rows.length} rows)`);
        this.latest.set(cur, snap);
        if (g.persist) this.store.insertGexSnapshot(snap);
      } catch (e) {
        this.failures++;
        this.log(`${cur} refresh failed: ${(e as Error).message}`);
      }
    }
  }

  snapshot(currency: string): GexSnapshot | undefined {
    return this.latest.get(currency);
  }

  gexFor(symbol: string, _ts: number): GexView | null {
    const cur = this.cfg.gex.underlyings[symbol];
    const s = cur ? this.latest.get(cur) : undefined;
    return s ? { underlying: s.underlying, ts: s.ts, spot: s.spot, flipLevel: s.flipLevel, totalGex: s.totalGex } : null;
  }
}
