import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CandleChart, type ChartLevel } from '../../../components/CandleChart';
import { DirBadge, NoDb, OutcomeBadge, R } from '../../../components/ui';
import { openDb } from '../../../lib/db';
import { fmtPrice, fmtTime, num } from '../../../lib/format';
import { getSignal, signalChart } from '../../../lib/queries';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = openDb();
  if (!db.ok) return <NoDb state={db} />;
  const d = Number.isInteger(Number(id)) ? getSignal(db.store, Number(id)) : null;
  if (!d) notFound();
  const s = d.signal, inp = d.inputs, cf = inp.confluence;
  const chart = signalChart(db.store, d);
  const prof = inp.profile;
  const levels: ChartLevel[] = prof ? [
    { price: prof.poc, label: 'POC' }, { price: prof.vah, label: 'VAH' }, { price: prof.val, label: 'VAL' },
    ...(prof.hvns ?? []).map((h: { price: number }) => ({ price: h.price, label: 'HVN' })),
  ] : [];
  const markers = [
    s.t1Ts ? { ts: s.t1Ts, label: 'T1 hit' } : null, s.t2Ts ? { ts: s.t2Ts, label: 'T2 hit' } : null, s.stopTs ? { ts: s.stopTs, label: 'stop hit' } : null,
    s.closedTs && !s.t2Ts && !s.stopTs ? { ts: s.closedTs, label: s.outcome ?? 'closed' } : null,
  ].filter((m): m is { ts: number; label: string } => m != null);
  const risk = Math.abs(s.entry - s.stop);
  return (
    <>
      <p className="small"><Link href="/signals">← signals</Link></p>
      <h1>{s.symbol} <DirBadge d={s.direction} /> <OutcomeBadge s={s} /> <R v={s.realizedR} /></h1>
      <p className="sub">#{s.id} · run {s.runId} · {fmtTime(s.ts)} · score {num(s.score, 1)}</p>

      <CandleChart candles={chart.candles} fromTs={chart.fromTs} toTs={chart.toTs} levels={levels} signalTs={s.ts} markers={markers}
        plan={{ direction: s.direction, entry: s.entry, entryLo: s.entryLo, entryHi: s.entryHi, stop: s.stop, t1: s.t1, t2: s.t2 }} />
      <div className="legend"><span><i style={{ background: 'var(--down)' }} />stop</span><span><i style={{ background: 'var(--up)' }} />targets</span><span><i style={{ background: 'var(--muted)' }} />profile levels</span><span><i style={{ background: 'var(--accent)' }} />entry zone / signal time</span></div>

      <div className="grid g3" style={{ marginTop: 8 }}>
        <div className="card"><h3>Trade plan</h3>
          <table><tbody>
            <tr><td>Entry zone</td><td className="r">{fmtPrice(s.entryLo)} – {fmtPrice(s.entryHi)}</td></tr>
            <tr><td>Reference entry</td><td className="r">{fmtPrice(s.entry)}</td></tr>
            <tr><td>Stop</td><td className="r down">{fmtPrice(s.stop)} <span className="mut small">({num(risk / s.atr, 2)} ATR risk)</span></td></tr>
            <tr><td>T1</td><td className="r up">{fmtPrice(s.t1)} <span className="mut small">({num(s.rrT1)}R)</span></td></tr>
            <tr><td>T2</td><td className="r up">{fmtPrice(s.t2)} <span className="mut small">({num(s.rrT2)}R){inp.t2Synthetic ? ' · ATR-projected' : ''}</span></td></tr>
            <tr><td>ATR</td><td className="r">{fmtPrice(s.atr)}</td></tr>
          </tbody></table>
          <p className="small mut" style={{ marginBottom: 0 }}>Signal only — no order was or will be placed.</p>
        </div>
        <div className="card"><h3>Outcome</h3>
          <table><tbody>
            <tr><td>Status</td><td className="r"><OutcomeBadge s={s} /></td></tr>
            <tr><td>Realised</td><td className="r"><R v={s.realizedR} /></td></tr>
            <tr><td>T1 hit</td><td className="r">{s.t1Ts ? fmtTime(s.t1Ts) : '–'}</td></tr>
            <tr><td>T2 hit</td><td className="r">{s.t2Ts ? fmtTime(s.t2Ts) : '–'}</td></tr>
            <tr><td>Stop hit</td><td className="r">{s.stopTs ? fmtTime(s.stopTs) : '–'}</td></tr>
            <tr><td>Max for / against</td><td className="r"><span className="up">+{num(s.mfeR)}R</span> / <span className="down">−{num(s.maeR)}R</span></td></tr>
          </tbody></table>
        </div>
        <div className="card"><h3>Confluence</h3>
          {cf ? (
            <table><tbody>
              <tr><td>Flat sum of conditions</td><td className="r">{num(cf.raw, 1)}</td></tr>
              {Object.entries(cf.familyScores as Record<string, number>).map(([f, v]) => <tr key={f}><td>&nbsp;&nbsp;{f}</td><td className="r">{num(v, 1)}</td></tr>)}
              <tr><td>Diversity bonus ({cf.familyCount} families)</td><td className="r">×{cf.multiplier}</td></tr>
              <tr><td>Conflict penalty</td><td className="r">{cf.conflict ? `−${cf.conflict}` : '0'}</td></tr>
              <tr><td><b>Final score</b></td><td className="r"><b>{num(s.score, 1)}</b></td></tr>
            </tbody></table>
          ) : <p className="mut">No breakdown stored for this signal.</p>}
          {cf?.conflictConditions?.length > 0 && <p className="small mut" style={{ marginBottom: 0 }}>Opposing: {cf.conflictConditions.map((c: { key: string }) => c.key).join(', ')}</p>}
        </div>
      </div>

      <h2>Conditions that fired</h2>
      <div className="scroll"><table><thead><tr><th>Condition</th><th>Family</th><th className="r">Points</th><th>Inputs</th></tr></thead><tbody>
        {d.conditions.map((c) => (
          <tr key={c.key}><td><b>{c.key}</b></td><td>{c.family}</td><td className="r">{num(c.points, 0)}</td>
            <td className="wrapcell">{c.detail ? <details><summary>inputs</summary><pre>{JSON.stringify(c.detail, null, 2)}</pre></details> : '–'}</td></tr>
        ))}
      </tbody></table></div>

      <h2>Context at signal time</h2>
      <div className="grid g4">
        <div className="card"><h3>Price</h3><div className="big">{fmtPrice(inp.price)}</div></div>
        <div className="card"><h3>Near distance</h3><div className="big">{fmtPrice(inp.near)}</div></div>
        <div className="card"><h3>15m delta z</h3><div className="big">{inp.htfZ == null ? '–' : num(inp.htfZ)}</div></div>
        <div className="card"><h3>Min R:R / threshold</h3><div className="big">{inp.thresholds ? `${inp.thresholds.minRR} / ${inp.thresholds.threshold}` : '–'}</div></div>
      </div>
      {prof && <p className="small mut">Profile: POC {fmtPrice(prof.poc)} · VAH {fmtPrice(prof.vah)} · VAL {fmtPrice(prof.val)} · {prof.hvns?.length ?? 0} HVNs · traded level {inp.level ? `${inp.level.kind} ${fmtPrice(inp.level.price)}` : '–'}</p>}
      <details><summary>Raw inputs (JSON)</summary><pre>{JSON.stringify(inp, null, 2)}</pre></details>
    </>
  );
}
