import { Empty, NoDb, Select } from '../../components/ui';
import { dashConfig } from '../../lib/config';
import { openDb } from '../../lib/db';
import { fmtTime } from '../../lib/format';
import { first, type SP } from '../../lib/params';
import { alertTypes, listAlerts, listRuns } from '../../lib/queries';
import { AutoRefresh } from '../../components/AutoRefresh';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = openDb();
  if (!db.ok) return <NoDb state={db} />;
  const cfg = dashConfig();
  const run = first(sp.run) ?? 'live', symbol = first(sp.symbol), type = first(sp.type);
  const alerts = listAlerts(db.store, { run, symbol, type, limit: 100 });
  const runs = new Set(['live', ...listRuns(db.store).map((r) => r.runId)]);
  return (
    <>
      <h1>Alerts {run === 'live' && <AutoRefresh seconds={15} />}</h1>
      <p className="sub">Everything that was (or, for backtests, would have been) sent to Telegram, with the inputs that triggered it.</p>
      <form className="filters" method="get">
        <Select name="run" label="Run" value={run} options={[...runs]} />
        <Select name="symbol" label="Asset" value={symbol} options={[['', 'all'], ...Object.keys(cfg.assets).map((s) => [s, s] as [string, string])]} />
        <Select name="type" label="Type" value={type} options={['', ...alertTypes(db.store, run)]} />
        <button type="submit">Filter</button>
      </form>
      {alerts.length === 0 ? <Empty>No alerts match.</Empty> : (
        <div className="scroll"><table><thead><tr><th>Time (UTC)</th><th>Asset</th><th>Type</th><th>Message</th><th>Inputs</th></tr></thead><tbody>
          {alerts.map((a) => (
            <tr key={a.id}>
              <td>{fmtTime(a.ts)}</td><td>{a.symbol.replace('USDT', '')}</td><td><span className="chip">{a.type}</span></td>
              <td className="wrapcell" style={{ whiteSpace: 'pre-line' }}>{a.text}</td>
              <td className="wrapcell"><details><summary>inputs</summary><pre>{JSON.stringify(JSON.parse(a.inputs), null, 2)}</pre></details></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      <p className="small mut">Showing the latest 100.</p>
    </>
  );
}
