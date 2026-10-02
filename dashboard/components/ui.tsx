import Link from 'next/link';
import type { ReactNode } from 'react';
import type { DbState } from '../lib/db';
import { fmtPrice, fmtTime, num, signed } from '../lib/format';
import type { SignalListRow } from '../lib/queries';

export function NoDb({ state }: { state: Extract<DbState, { ok: false }> }) {
  return (
    <div className={`notice ${state.reason === 'missing' ? '' : 'err'}`} style={{ marginTop: 24 }}>
      <b>{state.reason === 'missing' ? 'No data yet' : 'Cannot read the database'}</b>
      <p style={{ margin: '6px 0' }}>{state.detail}</p>
      <p className="small mut" style={{ margin: 0 }}>Looking for <code>{state.path}</code> (override with the <code>DB_PATH</code> environment variable).</p>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="notice mut">{children}</div>;
}

export const DirBadge = ({ d }: { d: string }) => <span className={`badge ${d.toLowerCase()}`}>{d}</span>;

export function OutcomeBadge({ s }: { s: Pick<SignalListRow, 'status' | 'outcome' | 'realizedR'> }) {
  if (s.status === 'OPEN') return <span className="badge warn">open</span>;
  const win = (s.realizedR ?? 0) > 0;
  return <span className={`badge ${win ? 'win' : 'loss'}`}>{s.outcome}</span>;
}

export const R = ({ v }: { v: number | null | undefined }) => <span className={v == null ? 'mut' : v > 0 ? 'up' : v < 0 ? 'down' : ''}>{v == null ? '–' : `${signed(v)}R`}</span>;

export function SignalsTable({ rows, showRun = false }: { rows: SignalListRow[]; showRun?: boolean }) {
  if (!rows.length) return <Empty>No signals match.</Empty>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr><th>Time (UTC)</th>{showRun && <th>Run</th>}<th>Asset</th><th>Side</th><th className="r">Score</th><th className="r">Entry</th><th className="r">Stop</th><th className="r">T1</th><th className="r">T2</th><th className="r">R:R</th><th>Result</th><th className="r">R</th><th>Conditions</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td><Link href={`/signals/${s.id}`}>{fmtTime(s.ts)}</Link></td>
              {showRun && <td>{s.runId}</td>}
              <td>{s.symbol.replace('USDT', '')}</td><td><DirBadge d={s.direction} /></td>
              <td className="r">{num(s.score, 1)}</td><td className="r">{fmtPrice(s.entry)}</td><td className="r">{fmtPrice(s.stop)}</td>
              <td className="r">{fmtPrice(s.t1)}</td><td className="r">{fmtPrice(s.t2)}</td><td className="r">{num(s.rr)}</td>
              <td><OutcomeBadge s={s} /></td><td className="r"><R v={s.realizedR} /></td>
              <td className="wrapcell">{s.conditions.map((c) => <span className="chip" key={c}>{c}</span>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Select({ name, label, value, options }: { name: string; label: string; value?: string; options: (string | [string, string])[] }) {
  return (
    <label>{label}
      <select name={name} defaultValue={value ?? ''}>
        {options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o || 'all']; return <option key={v} value={v}>{l}</option>; })}
      </select>
    </label>
  );
}
