import { fmtPrice } from '../lib/format';
import { spreadLabels } from '../lib/labels';

const fmtM = (v: number) => `${(v / 1e6).toFixed(1)}M`;

/** Net GEX per strike (calls up, puts down) with the spot and flip levels marked. */
export function GexBars({ strikes, spot, flip }: { strikes: { strike: number; gex: number; callGex: number; putGex: number }[]; spot: number; flip: number | null }) {
  const W = 1000, H = 340, ML = 52, MR = 12, MT = 14, MB = 26;
  const view = strikes.filter((s) => s.strike >= spot * 0.8 && s.strike <= spot * 1.2);
  if (!view.length) return <div className="notice mut">No strikes near spot.</div>;
  const lo = Math.min(...view.map((s) => s.strike), flip ?? Infinity, spot), hi = Math.max(...view.map((s) => s.strike), flip ?? -Infinity, spot);
  const maxAbs = Math.max(...view.map((s) => Math.max(Math.abs(s.callGex), Math.abs(s.putGex), Math.abs(s.gex))), 1);
  const x = (p: number) => ML + ((p - lo) / Math.max(1e-9, hi - lo)) * (W - ML - MR);
  const y0 = MT + (H - MT - MB) / 2, k = (H - MT - MB) / 2 / maxAbs;
  const bw = Math.max(2, Math.min(18, ((W - ML - MR) / view.length) * 0.7));
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="GEX by strike">
      <line x1={ML} x2={W - MR} y1={y0} y2={y0} stroke="var(--grid)" />
      <text x={4} y={MT + 8}>+{fmtM(maxAbs)}</text><text x={4} y={H - MB}>−{fmtM(maxAbs)}</text>
      {view.map((s) => (
        <g key={s.strike}>
          <rect x={x(s.strike) - bw / 2} width={bw} y={y0 - s.callGex * k} height={Math.max(0, s.callGex * k)} className="c-up" opacity={0.45} />
          <rect x={x(s.strike) - bw / 2} width={bw} y={y0} height={Math.max(0, -s.putGex * k)} className="c-down" opacity={0.45} />
          <rect x={x(s.strike) - bw * 0.2} width={bw * 0.4} y={s.gex >= 0 ? y0 - s.gex * k : y0} height={Math.abs(s.gex) * k} fill="var(--text)" opacity={0.7} />
        </g>
      ))}
      <line x1={x(spot)} x2={x(spot)} y1={MT} y2={H - MB} stroke="var(--accent)" strokeWidth={1.5} />
      <text x={x(spot) + 4} y={MT + 10} style={{ fill: 'var(--accent)' }}>spot {fmtPrice(spot)}</text>
      {flip != null && <>
        <line x1={x(flip)} x2={x(flip)} y1={MT} y2={H - MB} stroke="var(--warn)" strokeWidth={1.5} strokeDasharray="5 4" />
        <text x={x(flip) + 4} y={H - MB - 6} style={{ fill: 'var(--warn)' }}>flip {fmtPrice(flip)}</text>
      </>}
      {[0, 0.25, 0.5, 0.75, 1].map((t) => <text key={t} x={ML + t * (W - ML - MR)} y={H - 8} textAnchor="middle">{fmtPrice(lo + t * (hi - lo))}</text>)}
    </svg>
  );
}

/** Horizontal volume-by-price histogram with POC / value area / HVN marks. */
export function ProfileBars({ bins, poc, vah, val, hvns, last }: { bins: { price: number; volume: number }[]; poc: number; vah: number; val: number; hvns: number[]; last: number | null }) {
  const W = 1000, ML = 80, MR = 120, MT = 10;
  if (!bins.length) return <div className="notice mut">No trades in this window.</div>;
  const lo = bins[0].price, hi = bins[bins.length - 1].price;
  const rowH = 4;
  const rows = Math.round((hi - lo) / (bins.length > 1 ? Math.min(...bins.slice(1).map((b, i) => b.price - bins[i].price)) : 1)) + 1;
  const H = MT * 2 + Math.max(240, Math.min(720, rows * rowH));
  const maxV = Math.max(...bins.map((b) => b.volume));
  const y = (p: number) => MT + ((hi - p) / Math.max(1e-9, hi - lo)) * (H - 2 * MT);
  const bh = Math.max(1.5, (H - 2 * MT) / rows - 0.5);
  const marks: { p: number; label: string; color: string; dash: string }[] = [
    { p: poc, label: 'POC', color: 'var(--warn)', dash: '0' }, { p: vah, label: 'VAH', color: 'var(--accent)', dash: '4 4' }, { p: val, label: 'VAL', color: 'var(--accent)', dash: '4 4' },
    ...hvns.map((p) => ({ p, label: 'HVN', color: 'var(--up)', dash: '2 4' })),
    ...(last != null ? [{ p: last, label: 'last', color: 'var(--text)', dash: '1 3' }] : []),
  ];
  const labels = spreadLabels(marks.map((m) => ({ ...m, y: y(m.p) })), 12, MT + 6, H - MT);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Volume profile">
      <rect x={ML} width={W - ML - MR} y={y(vah)} height={Math.max(1, y(val) - y(vah))} fill="var(--accent)" opacity={0.08} />
      {bins.map((b) => {
        const inVa = b.price >= val && b.price <= vah;
        return <rect key={b.price} x={ML} y={y(b.price) - bh / 2} width={Math.max(1, (b.volume / maxV) * (W - ML - MR))} height={bh} fill={inVa ? 'var(--accent)' : 'var(--muted)'} opacity={inVa ? 0.75 : 0.5} />;
      })}
      {marks.map((m) => <line key={m.label + m.p} x1={ML} x2={W - MR} y1={y(m.p)} y2={y(m.p)} stroke={m.color} strokeDasharray={m.dash} />)}
      {labels.map((m) => <text key={m.label + m.p} x={W - MR + 4} y={m.ly + 4} style={{ fill: m.color }}>{m.label} {fmtPrice(m.p)}</text>)}
      {[0, 0.25, 0.5, 0.75, 1].map((t) => <text key={t} x={4} y={y(lo + t * (hi - lo)) + 4}>{fmtPrice(lo + t * (hi - lo))}</text>)}
    </svg>
  );
}

/** Two aligned lines (e.g. spot vs GEX flip) over time. */
export function TwoLines({ a, b, labelA, labelB }: { a: [number, number][]; b: [number, number][]; labelA: string; labelB: string }) {
  const W = 1000, H = 180, ML = 60, MR = 12, MT = 10, MB = 22;
  const all = [...a, ...b];
  if (a.length < 2) return <div className="notice mut">Not enough history yet (snapshots are taken every few minutes).</div>;
  const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(...all.map((p) => p[0]));
  const lo = Math.min(...all.map((p) => p[1])), hi = Math.max(...all.map((p) => p[1]));
  const x = (t: number) => ML + ((t - t0) / Math.max(1, t1 - t0)) * (W - ML - MR);
  const y = (v: number) => MT + ((hi - v) / Math.max(1e-9, hi - lo)) * (H - MT - MB);
  const path = (s: [number, number][]) => s.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${labelA} and ${labelB} over time`}>
      <text x={4} y={MT + 8}>{fmtPrice(hi)}</text><text x={4} y={H - MB}>{fmtPrice(lo)}</text>
      <path d={path(a)} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
      {b.length > 1 && <path d={path(b)} fill="none" stroke="var(--warn)" strokeWidth={1.5} strokeDasharray="5 4" />}
      <text x={ML} y={H - 6} style={{ fill: 'var(--accent)' }}>— {labelA}</text>
      <text x={ML + 90} y={H - 6} style={{ fill: 'var(--warn)' }}>-- {labelB}</text>
    </svg>
  );
}
