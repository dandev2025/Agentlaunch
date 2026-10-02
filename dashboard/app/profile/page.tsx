import { ProfileBars } from '../../components/Bars';
import { Empty, NoDb, Select } from '../../components/ui';
import { dashConfig } from '../../lib/config';
import { openDb } from '../../lib/db';
import { fmtPrice } from '../../lib/format';
import { first, int, type SP } from '../../lib/params';
import { profile } from '../../lib/queries';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = openDb();
  if (!db.ok) return <NoDb state={db} />;
  const cfg = dashConfig();
  const symbol = first(sp.symbol) ?? Object.keys(cfg.assets)[0];
  const hours = int(sp.hours, 24, 1, 48);
  const p = profile(db.store, cfg, symbol, hours);
  const s = p.snapshot;
  return (
    <>
      <h1>Volume profile</h1>
      <p className="sub">Rebuilt from stored trades with the same settings the signal engine uses (value area {cfg.volumeProfile.valueAreaPct * 100}%, HVN ≥ {cfg.volumeProfile.hvnFactor}× the average bin). These are the levels signals are built around.</p>
      <form className="filters" method="get">
        <Select name="symbol" label="Asset" value={symbol} options={Object.keys(cfg.assets)} />
        <Select name="hours" label="Window" value={String(hours)} options={[['4', '4 h'], ['8', '8 h'], ['24', '24 h'], ['48', '48 h']]} />
        <button type="submit">Show</button>
      </form>
      {!s ? <Empty>No trades stored for {symbol} in the last {hours}h.</Empty> : (
        <>
          <ProfileBars bins={p.bins} poc={s.poc} vah={s.vah} val={s.val} hvns={s.hvns.map((h) => h.price)} last={p.lastPrice} />
          <p className="small mut">
            POC {fmtPrice(s.poc)} · VAH {fmtPrice(s.vah)} · VAL {fmtPrice(s.val)} · HVNs {s.hvns.length ? s.hvns.map((h) => fmtPrice(h.price)).join(', ') : 'none'} · {p.trades.toLocaleString('en-US')} trades · bin {s.binSize}
          </p>
        </>
      )}
    </>
  );
}
