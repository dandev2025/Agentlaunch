import Link from 'next/link';
import { AutoRefresh } from '../components/AutoRefresh';
import { Empty, NoDb, SignalsTable } from '../components/ui';
import { dashConfig } from '../lib/config';
import { openDb } from '../lib/db';
import { ago, fmtPrice, fmtTime, stripHtml } from '../lib/format';
import { overview } from '../lib/queries';

export const dynamic = 'force-dynamic';

const health = (ageMs: number | null) => (ageMs == null ? ['stale', 'no data'] : ageMs < 30_000 ? ['ok', 'live'] : ageMs < 180_000 ? ['warn', 'slow'] : ['stale', 'stale']);

export default function Page() {
  const db = openDb();
  if (!db.ok) return <NoDb state={db} />;
  const o = overview(db.store, dashConfig());
  return (
    <>
      <h1>Overview <AutoRefresh seconds={10} /></h1>
      <p className="sub">Live run · data as of {fmtTime(o.now)} · everything here is read from the collector&apos;s database</p>

      <div className="grid g3">
        {o.symbols.map((s) => {
          const [cls, label] = health(s.ageMs);
          return (
            <div className="card" key={s.symbol}>
              <h3>{s.symbol} <span className={`badge ${cls}`}>{label}</span></h3>
              <div className="big">{s.price == null ? '–' : fmtPrice(s.price)}</div>
              <div className="small mut">last trade {ago(s.ageMs)} ago · {s.trades5m.toLocaleString('en-US')} trades / 5m</div>
              <div className="small" style={{ marginTop: 6 }}>
                {s.bigTrades24h} big trades 24h · {s.openSignals} open {s.openSignals === 1 ? 'signal' : 'signals'} · {s.activeWalls} {s.activeWalls === 1 ? 'wall' : 'walls'}
              </div>
              {s.gex && <div className="small mut">GEX flip {s.gex.flip == null ? 'none' : fmtPrice(s.gex.flip)} ({ago(s.gex.ageMs)} old)</div>}
            </div>
          );
        })}
      </div>

      <div className="grid g4" style={{ marginTop: 12 }}>
        <div className="card"><h3>Signals 24h</h3><div className="big">{o.counts.signals24h}</div></div>
        <div className="card"><h3>Open signals</h3><div className="big">{o.counts.open}</div></div>
        <div className="card"><h3>Alerts 24h</h3><div className="big">{o.counts.alerts24h}</div></div>
        <div className="card">
          <h3>Data gaps 24h</h3>
          <div className={`big ${o.gaps.unrecovered ? 'warnc' : ''}`}>{o.gaps.count}</div>
          <div className="small mut">{o.gaps.missing} trades missing, {o.gaps.unrecovered} not recovered</div>
        </div>
      </div>

      <h2>Open signals</h2>
      {o.openSignals.length ? <SignalsTable rows={o.openSignals} /> : <Empty>No open signals.</Empty>}

      <h2>Recent signals · <Link href="/signals">all</Link></h2>
      {o.recentSignals.length ? <SignalsTable rows={o.recentSignals} /> : <Empty>No signals yet. They appear once enough conditions line up (see the Performance page for how often that happens in backtests).</Empty>}

      <h2>Recent alerts · <Link href="/alerts">all</Link></h2>
      {o.recentAlerts.length ? (
        <div className="scroll"><table><thead><tr><th>Time (UTC)</th><th>Asset</th><th>Type</th><th>Message</th></tr></thead><tbody>
          {o.recentAlerts.map((a) => (
            <tr key={a.id}><td>{fmtTime(a.ts)}</td><td>{a.symbol.replace('USDT', '')}</td><td><span className="chip">{a.type}</span></td>
              <td className="wrapcell">{stripHtml(a.text).split('\n').slice(0, 2).join(' — ')}</td></tr>
          ))}
        </tbody></table></div>
      ) : <Empty>No alerts yet.</Empty>}
    </>
  );
}
