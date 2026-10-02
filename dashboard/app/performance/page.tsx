import { Empty, NoDb, Select } from '../../components/ui';
import { openDb } from '../../lib/db';
import { num, pct } from '../../lib/format';
import { first, type SP } from '../../lib/params';
import { compare, listRuns, performance } from '../../lib/queries';
import type { ConditionStats, Stats } from '../../../src/backtest/report';

export const dynamic = 'force-dynamic';

const cls = (v: number | null) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');

function StatRows({ rows }: { rows: [string, Stats][] }) {
  return <>{rows.map(([k, s]) => (
    <tr key={k}><td>{k}</td><td className="r">{s.n}</td><td className="r">{pct(s.winRate)}</td><td className={`r ${cls(s.avgR)}`}>{num(s.avgR)}</td><td className={`r ${cls(s.totalR)}`}>{num(s.totalR)}</td><td className="r">{num(s.profitFactor)}</td><td className="r">{num(s.avgMfeR)}</td><td className="r">{num(s.avgMaeR)}</td></tr>
  ))}</>;
}

function StatsTable({ title, first: head, rows }: { title: string; first: string; rows: [string, Stats][] }) {
  return (
    <>
      <h2>{title}</h2>
      {rows.length === 0 ? <Empty>Nothing to show yet.</Empty> : (
        <div className="scroll"><table><thead><tr><th>{head}</th><th className="r">n</th><th className="r">win %</th><th className="r">avg R</th><th className="r">total R</th><th className="r">PF</th><th className="r">avg MFE</th><th className="r">avg MAE</th></tr></thead><tbody><StatRows rows={rows} /></tbody></table></div>
      )}
    </>
  );
}

function LiftTable({ title, rows }: { title: string; rows: ConditionStats[] }) {
  return (
    <>
      <h2>{title}</h2>
      {rows.length === 0 ? <Empty>Nothing to show yet.</Empty> : (
        <div className="scroll"><table><thead><tr><th>{title.includes('family') ? 'Family' : 'Condition'}</th><th className="r">n</th><th className="r">win %</th><th className="r">avg R</th><th className="r">total R</th><th className="r">avg R without</th><th className="r">lift</th></tr></thead><tbody>
          {rows.map((c) => (
            <tr key={c.key}><td>{c.key}</td><td className="r">{c.n}</td><td className="r">{pct(c.winRate)}</td><td className={`r ${cls(c.avgR)}`}>{num(c.avgR)}</td><td className={`r ${cls(c.totalR)}`}>{num(c.totalR)}</td><td className="r">{num(c.avgRWithout)}</td><td className={`r ${cls(c.lift)}`}>{num(c.lift)}</td></tr>
          ))}
        </tbody></table></div>
      )}
    </>
  );
}

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = openDb();
  if (!db.ok) return <NoDb state={db} />;
  const runs = listRuns(db.store);
  if (!runs.length) return <><h1>Performance</h1><Empty>No signals recorded yet. Run a backtest (<code>npm run replay</code>) or let the collector run.</Empty></>;
  const a = first(sp.run) ?? runs[0].runId, b = first(sp.vs);
  const rep = performance(db.store, a);
  const cmp = b && b !== a ? compare(db.store, a, b) : null;
  const runOpts = runs.map((r) => [r.runId, `${r.runId} — ${r.closed}/${r.signals} closed`] as [string, string]);
  return (
    <>
      <h1>Performance</h1>
      <p className="sub">Win rate, average R and per-condition lift — the numbers for tuning weights. Realised R assumes entry at the signal price with no fees/slippage; half is banked at T1.</p>
      <form className="filters" method="get">
        <Select name="run" label="Run" value={a} options={runOpts} />
        <Select name="vs" label="Compare with" value={b} options={[['', 'none'], ...runOpts.filter(([v]) => v !== a)]} />
        <button type="submit">Show</button>
      </form>
      <p className="small mut">{rep.total} signals · {rep.overall.n} closed · {rep.open} still open (excluded)</p>
      {rep.overall.n < 30 && <div className="notice warnc" style={{ marginBottom: 12 }}>⚠ Fewer than 30 closed signals — treat every number below as noise, not evidence.</div>}

      {cmp && (
        <>
          <h2>{a} vs {b}</h2>
          <div className="scroll"><table><thead><tr><th></th><th className="r">n</th><th className="r">win %</th><th className="r">avg R</th><th className="r">total R</th><th className="r">PF</th><th className="r">avg MFE</th><th className="r">avg MAE</th></tr></thead><tbody>
            <StatRows rows={[[`${a} overall`, cmp.overall.a], [`${b} overall`, cmp.overall.b], [`in both — ${a}'s outcome`, cmp.common.a], [`in both — ${b}'s outcome`, cmp.common.b], [`only in ${a}`, cmp.onlyA], [`only in ${b}`, cmp.onlyB]]} />
          </tbody></table></div>
          <p className="small mut">If “only in {a}” has a negative avg R, {b} was right to skip those signals. Cooldowns shift later signals too, so the “only in” rows are partly an artefact of timing, not purely the scoring change.</p>
        </>
      )}

      <StatsTable title="Overall" first="" rows={[['ALL', rep.overall], ...Object.entries(rep.byDirection), ...Object.entries(rep.bySymbol)]} />
      <LiftTable title="Per condition (lift = avg R with − without)" rows={rep.byCondition} />
      <LiftTable title="Per indicator family" rows={rep.byFamily} />
      <StatsTable title="By score — does a higher score do better?" first="Score" rows={[...rep.byScoreBucket.map((x): [string, Stats] => [x.bucket, x]), ...Object.entries(rep.byFamilyCount).map(([k, v]): [string, Stats] => [`${k} families`, v])]} />
      <p className="small mut">Outcomes: {Object.entries(rep.overall.outcomes).map(([k, v]) => `${k}=${v}`).join('  ') || '–'}</p>
    </>
  );
}
