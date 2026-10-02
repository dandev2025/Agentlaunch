import { GexBars, TwoLines } from '../../components/Bars';
import { AutoRefresh } from '../../components/AutoRefresh';
import { Empty, NoDb, Select } from '../../components/ui';
import { dashConfig } from '../../lib/config';
import { openDb } from '../../lib/db';
import { ago, fmtPrice, fmtTime } from '../../lib/format';
import { first, int, type SP } from '../../lib/params';
import { gex } from '../../lib/queries';

export const dynamic = 'force-dynamic';
const M = (v: number) => `${(v / 1e6).toFixed(1)}M`;

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = openDb();
  if (!db.ok) return <NoDb state={db} />;
  const cfg = dashConfig();
  const cur = (first(sp.currency) === 'ETH' ? 'ETH' : 'BTC') as 'BTC' | 'ETH';
  const hours = int(sp.hours, 24, 1, 168);
  const g = gex(db.store, cur, hours);
  const l = g.latest;
  const top = l ? [...l.strikes].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, 10).sort((a, b) => b.strike - a.strike) : [];
  return (
    <>
      <h1>GEX — options gamma exposure <AutoRefresh seconds={60} /></h1>
      <p className="sub">From Deribit open interest (BTC and ETH only — SOL options are too thin). An estimate, not observed dealer positioning: calls count positive, puts negative.</p>
      <form className="filters" method="get">
        <Select name="currency" label="Underlying" value={cur} options={['BTC', 'ETH']} />
        <Select name="hours" label="History" value={String(hours)} options={[['6', '6 h'], ['24', '24 h'], ['72', '3 days'], ['168', '7 days']]} />
        <button type="submit">Show</button>
      </form>
      {!l ? <Empty>No GEX snapshot for {cur} yet. The collector polls Deribit every {cfg.gex.pollIntervalMs / 60000} minutes when <code>gex.enabled</code> is on. Check connectivity with <code>npm run gex -- --live</code>.</Empty> : (
        <>
          <div className="grid g4">
            <div className="card"><h3>Spot (Deribit index)</h3><div className="big">{fmtPrice(l.spot)}</div></div>
            <div className="card"><h3>Flip level</h3><div className="big">{l.flipLevel == null ? 'none in range' : fmtPrice(l.flipLevel)}</div>
              {l.flipLevel != null && <div className="small mut">{(((l.spot - l.flipLevel) / l.flipLevel) * 100).toFixed(2)}% {l.spot >= l.flipLevel ? 'above' : 'below'} it</div>}</div>
            <div className="card"><h3>Net GEX / 1% move</h3><div className={`big ${l.totalGex >= 0 ? 'up' : 'down'}`}>{M(l.totalGex)}</div>
              <div className="small mut">{l.totalGex >= 0 ? 'positive gamma: dealer hedging dampens moves' : 'negative gamma: dealer hedging amplifies moves'}</div></div>
            <div className="card"><h3>Snapshot</h3><div className="big">{ago(Date.now() - l.ts)} ago</div><div className="small mut">{fmtTime(l.ts)} · {l.instruments} options</div></div>
          </div>
          <h2>By strike</h2>
          <GexBars strikes={l.strikes} spot={l.spot} flip={l.flipLevel} />
          <div className="legend"><span><i style={{ background: 'var(--up)' }} />calls</span><span><i style={{ background: 'var(--down)' }} />puts</span><span><i style={{ background: 'var(--text)' }} />net</span><span><i style={{ background: 'var(--accent)' }} />spot</span><span><i style={{ background: 'var(--warn)' }} />flip</span></div>
          <h2>Spot vs flip level over time</h2>
          <TwoLines a={g.history.map((h) => [h.ts, h.spot])} b={g.history.filter((h) => h.flipLevel != null).map((h) => [h.ts, h.flipLevel as number])} labelA="spot" labelB="flip" />
          <h2>Biggest strikes</h2>
          <div className="scroll"><table><thead><tr><th className="r">Strike</th><th className="r">Net GEX</th><th className="r">Calls</th><th className="r">Puts</th><th className="r">Open interest</th></tr></thead><tbody>
            {top.map((s) => <tr key={s.strike}><td className="r">{fmtPrice(s.strike)}</td><td className={`r ${s.gex >= 0 ? 'up' : 'down'}`}>{M(s.gex)}</td><td className="r">{M(s.callGex)}</td><td className="r">{M(s.putGex)}</td><td className="r">{s.oi.toFixed(0)}</td></tr>)}
          </tbody></table></div>
        </>
      )}
    </>
  );
}
