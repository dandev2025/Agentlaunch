import { AutoRefresh } from '../../components/AutoRefresh';
import { MarketChart, OVERLAYS, type Overlay } from '../../components/MarketChart';
import { NoDb, Select } from '../../components/ui';
import { dashConfig } from '../../lib/config';
import { openDb } from '../../lib/db';
import { first, int, type SP } from '../../lib/params';
import { chartData } from '../../lib/queries';
import { fmtTime } from '../../lib/format';
import type { Timeframe } from '../../../src/core/types';

export const dynamic = 'force-dynamic';
const TFS: Timeframe[] = ['1m', '5m', '15m'];

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = openDb();
  if (!db.ok) return <NoDb state={db} />;
  const cfg = dashConfig();
  const symbol = first(sp.symbol) ?? Object.keys(cfg.assets)[0];
  const tf = (TFS as string[]).includes(first(sp.tf) ?? '') ? (first(sp.tf) as Timeframe) : '5m';
  const hours = int(sp.hours, 6, 1, 48);
  // first visit (no form submitted yet): everything on; afterwards only the ticked boxes
  const submitted = sp.f !== undefined;
  const picked = new Set([sp.o].flat().filter((v): v is string => !!v));
  const on = new Set<Overlay>(OVERLAYS.map(([k]) => k).filter((k) => !submitted || picked.has(k)));
  const d = chartData(db.store, cfg, symbol, tf, hours);
  return (
    <>
      <h1>Chart <AutoRefresh seconds={30} /></h1>
      <p className="sub">Price with the order-flow indicators on top. Tick what you want to see; every overlay is read from what the collector stored, so a layer is empty for periods it wasn&apos;t running.</p>
      <form className="filters" method="get">
        <input type="hidden" name="f" value="1" />
        <Select name="symbol" label="Asset" value={symbol} options={Object.keys(cfg.assets)} />
        <Select name="tf" label="Timeframe" value={tf} options={TFS} />
        <Select name="hours" label="Window" value={String(hours)} options={[['2', '2 h'], ['6', '6 h'], ['12', '12 h'], ['24', '24 h'], ['48', '48 h']]} />
        <span className="checks">
          {OVERLAYS.map(([k, label]) => <label key={k}><input type="checkbox" name="o" value={k} defaultChecked={on.has(k)} /> {label}</label>)}
        </span>
        <button type="submit">Show</button>
      </form>
      <MarketChart d={d} on={on} />
      <p className="small mut">
        {d.candles.length} candles · {fmtTime(d.fromTs)} → {fmtTime(d.toTs)} UTC · {d.walls.length} walls · {d.bigTrades.length} big trades · {d.footprint.length} footprint events · {d.signals.length} signals.
        Footprint marks: solid = absorption, dotted = stacked imbalance; green supports LONG, red SHORT. Walls: green bid, red ask, dashed once pulled or eaten. Footprint events exist only for the footprint timeframes in the config.
      </p>
    </>
  );
}
