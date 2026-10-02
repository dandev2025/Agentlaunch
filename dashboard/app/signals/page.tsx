import Link from 'next/link';
import { Empty, NoDb, Select, SignalsTable } from '../../components/ui';
import { dashConfig } from '../../lib/config';
import { openDb } from '../../lib/db';
import { first, int, type SP } from '../../lib/params';
import { listRuns, listSignals } from '../../lib/queries';

export const dynamic = 'force-dynamic';
const PAGE = 50;

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = openDb();
  if (!db.ok) return <NoDb state={db} />;
  const cfg = dashConfig();
  const run = first(sp.run) ?? 'live', symbol = first(sp.symbol), direction = first(sp.direction), status = first(sp.status);
  const page = int(sp.page, 1);
  const { rows, total } = listSignals(db.store, { run, symbol, direction, status, limit: PAGE, offset: (page - 1) * PAGE });
  const runs = listRuns(db.store);
  const qs = (p: number) => new URLSearchParams({ ...(run !== 'live' ? { run } : {}), ...(symbol ? { symbol } : {}), ...(direction ? { direction } : {}), ...(status ? { status } : {}), page: String(p) }).toString();
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <>
      <h1>Signals</h1>
      <p className="sub">Every signal with the conditions that fired. Click a time for the full breakdown and chart.</p>
      <form className="filters" method="get">
        <Select name="run" label="Run" value={run} options={[['live', 'live'], ...runs.filter((r) => r.runId !== 'live').map((r) => [r.runId, `${r.runId} (backtest)`] as [string, string])]} />
        <Select name="symbol" label="Asset" value={symbol} options={[['', 'all'], ...Object.keys(cfg.assets).map((s) => [s, s] as [string, string])]} />
        <Select name="direction" label="Side" value={direction} options={[['', 'all'], 'LONG', 'SHORT']} />
        <Select name="status" label="Status" value={status} options={[['', 'all'], ['OPEN', 'open'], ['CLOSED', 'closed'], ['WIN', 'wins'], ['LOSS', 'losses']]} />
        <button type="submit">Filter</button>
      </form>
      <p className="small mut">{total} signals{pages > 1 ? ` · page ${page} of ${pages}` : ''}</p>
      {rows.length ? <SignalsTable rows={rows} showRun={run !== 'live'} /> : <Empty>No signals match these filters.</Empty>}
      {pages > 1 && (
        <p>{page > 1 && <Link href={`/signals?${qs(page - 1)}`}>← newer</Link>}{page > 1 && page < pages && ' · '}{page < pages && <Link href={`/signals?${qs(page + 1)}`}>older →</Link>}</p>
      )}
    </>
  );
}
