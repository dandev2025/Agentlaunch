import { HeatmapCanvas } from '../../components/HeatmapCanvas';
import { AutoRefresh } from '../../components/AutoRefresh';
import { Empty, NoDb, Select } from '../../components/ui';
import { dashConfig } from '../../lib/config';
import { openDb } from '../../lib/db';
import { fmtPrice } from '../../lib/format';
import { first, int, type SP } from '../../lib/params';
import { heatmap } from '../../lib/queries';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const db = openDb();
  if (!db.ok) return <NoDb state={db} />;
  const cfg = dashConfig();
  const symbol = first(sp.symbol) ?? Object.keys(cfg.assets)[0];
  const hours = int(sp.hours, 4, 1, 72);
  const h = heatmap(db.store, cfg, symbol, hours);
  const counts: Record<string, number> = {};
  for (const w of h.walls) counts[w.status] = (counts[w.status] ?? 0) + 1;
  return (
    <>
      <h1>Order-book heat map <AutoRefresh seconds={30} /></h1>
      <p className="sub">Resting liquidity over time near price, from the order-book snapshots the collector stores (every {cfg.heatmap.snapshot.intervalMs / 1000}s, ±{cfg.heatmap.rangePct * 100}% of mid). Brighter = bigger resting size.</p>
      <form className="filters" method="get">
        <Select name="symbol" label="Asset" value={symbol} options={Object.keys(cfg.assets)} />
        <Select name="hours" label="Window" value={String(hours)} options={[['1', '1 h'], ['4', '4 h'], ['12', '12 h'], ['24', '24 h'], ['72', '72 h']]} />
        <button type="submit">Show</button>
      </form>
      {h.snapshots === 0 ? (
        <Empty>No order-book snapshots for {symbol} in this window. They are recorded while the collector runs with <code>heatmap.enabled</code> and depth streaming on.</Empty>
      ) : (
        <>
          <HeatmapCanvas grid={h.grid} walls={h.walls} line={h.line} />
          <div className="legend">
            <span><i style={{ background: '#35c4b0' }} />bids</span><span><i style={{ background: '#f0a04b' }} />asks</span><span><i style={{ background: '#e3e8ef' }} />price (1m closes)</span>
            <span><i style={{ background: '#ffffff' }} />wall standing</span><span><i style={{ background: '#ff4dd2' }} />wall pulled</span><span><i style={{ background: '#ff5c5c' }} />wall eaten</span><span><i style={{ background: '#8b97a8' }} />wall expired (tracking stopped)</span>
          </div>
          <p className="small mut">{h.snapshots} snapshots · price window {fmtPrice(h.grid.pMin)} – {fmtPrice(h.grid.pMax)} · walls shown: {Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}. Cells show the largest size seen in that time/price bucket; hover for values.</p>
        </>
      )}
      {h.walls.length > 0 && (
        <>
          <h2>Walls in view</h2>
          <div className="scroll"><table><thead><tr><th>Side</th><th className="r">Price</th><th>First seen (UTC)</th><th className="r">Lived</th><th className="r">Peak</th><th className="r">Traded into</th><th>Status</th></tr></thead><tbody>
            {[...h.walls].reverse().slice(0, 40).map((w, i) => (
              <tr key={i}><td>{w.side}</td><td className="r">{fmtPrice(w.price)}</td><td>{new Date(w.firstSeen).toISOString().slice(5, 19).replace('T', ' ')}</td>
                <td className="r">{Math.round((w.lastSeen - w.firstSeen) / 1000)}s</td><td className="r">{w.peak.toFixed(1)}</td><td className="r">{w.executed.toFixed(1)}</td>
                <td><span className={`badge ${w.status === 'active' ? 'ok' : w.status === 'expired' ? '' : 'warn'}`}>{w.status}</span></td></tr>
            ))}
          </tbody></table></div>
        </>
      )}
    </>
  );
}
