import { Empty, NoDb, Select } from '../../components/ui';
import { dashConfig } from '../../lib/config';
import { openDb } from '../../lib/db';
import { fmtPrice, fmtTime, num } from '../../lib/format';
import { first, int, type SP } from '../../lib/params';
import { footprints, type FootprintView } from '../../lib/queries';
import type { Timeframe } from '../../../src/core/types';
import { AutoRefresh } from '../../components/AutoRefresh';

export const dynamic = 'force-dynamic';

function Ladder({ v }: { v: FootprintView }) {
  const c = v.candle;
  const maxVol = Math.max(1e-9, ...c.levels.map((l) => Math.max(l.bid, l.ask)));
  const stackedRange = v.stacked.map((e) => [e.lo, e.hi, e.detail.side as string] as const);
  return (
    <div className="card">
      <h3>{fmtTime(c.ts)} · {c.tf}</h3>
      <div className="small">O {fmtPrice(c.open)} H {fmtPrice(c.high)} L {fmtPrice(c.low)} C {fmtPrice(c.close)} · delta <span className={v.delta >= 0 ? 'up' : 'down'}>{num(v.delta, 1)}</span></div>
      <div className="scroll" style={{ margin: '6px 0' }}>
        <table className="fp"><thead><tr><th className="px">price</th><th>bid (sells)</th><th>ask (buys)</th><th /></tr></thead><tbody>
          {[...c.levels].reverse().map((l, ri) => {
            const i = c.levels.length - 1 - ri;
            const marks = v.marks.filter((m) => m.index === i);
            return (
              <tr key={l.price}>
                <td className="px">{fmtPrice(l.price)}</td>
                <td className="cell bidc"><span className="bar" style={{ width: `${(l.bid / maxVol) * 100}%` }} /><b>{l.bid ? l.bid.toFixed(1) : ''}</b></td>
                <td className="cell askc"><span className="bar" style={{ width: `${(l.ask / maxVol) * 100}%` }} /><b>{l.ask ? l.ask.toFixed(1) : ''}</b></td>
                <td>{marks.map((m) => <span key={m.side} className={`mk ${m.side === 'buy' ? 'b' : 's'}`}>{m.side === 'buy' ? 'B▲' : 'S▼'}</span>)}</td>
              </tr>
            );
          })}
        </tbody></table>
      </div>
      {stackedRange.map(([lo, hi, side], i) => <div key={i} className="small"><span className={side === 'buy' ? 'up' : 'down'}>Stacked {side} imbalance</span> {fmtPrice(lo)}–{fmtPrice(hi)} → supports {side === 'buy' ? 'LONG' : 'SHORT'}</div>)}
      {v.absorption.map((e, i) => <div key={i} className="small"><span className={e.direction === 'LONG' ? 'up' : 'down'}>{String(e.detail.type).replace('_', ' ')}</span> {fmtPrice(e.lo)}–{fmtPrice(e.hi)} → supports {e.direction}</div>)}
    </div>
  );
}

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = openDb();
  if (!db.ok) return <NoDb state={db} />;
  const cfg = dashConfig();
  const symbol = first(sp.symbol) ?? Object.keys(cfg.assets)[0];
  const tfs = cfg.footprint.timeframes;
  const tf = (tfs.includes(first(sp.tf) as Timeframe) ? first(sp.tf) : tfs[0]) as Timeframe;
  const n = int(sp.n, 4, 1, 12);
  const views = footprints(db.store, cfg, symbol, tf, n);
  return (
    <>
      <h1>Footprint <AutoRefresh seconds={30} /></h1>
      <p className="sub">Aggressive sell volume (bid) and aggressive buy volume (ask) at each price. B▲ / S▼ mark diagonal imbalances ≥ {cfg.footprint.imbalanceRatio}:1; ≥ {cfg.footprint.stackedMin} in a row is a stacked imbalance. Same rules the signal engine uses.</p>
      <form className="filters" method="get">
        <Select name="symbol" label="Asset" value={symbol} options={Object.keys(cfg.assets)} />
        <Select name="tf" label="Timeframe" value={tf} options={tfs} />
        <Select name="n" label="Candles" value={String(n)} options={['2', '4', '8', '12']} />
        <button type="submit">Show</button>
      </form>
      {views.length === 0 ? <Empty>No footprint data for {symbol} {tf}. It is stored while the collector runs with <code>footprint.persist</code> on (live only; replays don&apos;t store it).</Empty> : (
        <div className="grid g3">{views.map((v) => <Ladder key={v.candle.ts} v={v} />)}</div>
      )}
    </>
  );
}
