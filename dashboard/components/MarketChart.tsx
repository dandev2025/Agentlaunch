import { fmtPrice } from '../lib/format';
import { spreadLabels } from '../lib/labels';
import type { ChartData } from '../lib/queries';

export const OVERLAYS = [
  ['profile', 'Profile levels'], ['walls', 'Book walls'], ['gex', 'GEX flip'], ['big', 'Big trades'],
  ['fp', 'Footprint marks'], ['sig', 'Signals'], ['cvd', 'Delta / CVD'],
] as const;
export type Overlay = (typeof OVERLAYS)[number][0];

const W = 1000, ML = 8, MR = 108, MT = 10, MB = 24;
const PH = 380, GAP = 14, DH = 110; // price pane, gap, delta/CVD pane

/** Server-rendered SVG: candles with switchable order-flow overlays and a delta / CVD pane underneath. */
export function MarketChart({ d, on }: { d: ChartData; on: Set<Overlay> }) {
  const { candles, fromTs, toTs } = d;
  if (!candles.length) return <div className="notice mut">No candles stored for {d.symbol} in this window.</div>;
  const showCvd = on.has('cvd');
  const H = MT + PH + (showCvd ? GAP + DH : 0) + MB;
  const step = candles.length > 1 ? candles[1].ts - candles[0].ts : 60_000;
  const span = Math.max(1, toTs - fromTs);
  const x = (ts: number) => ML + ((ts - fromTs) / span) * (W - ML - MR);
  const cw = Math.max(1.5, ((W - ML - MR) * step) / span * 0.7);

  // price range: candles, then pad; overlay prices outside the range are simply not drawn
  let lo = Math.min(...candles.map((c) => c.low)), hi = Math.max(...candles.map((c) => c.high));
  const pad = (hi - lo) * 0.05 || hi * 0.001;
  lo -= pad; hi += pad;
  const y = (p: number) => MT + ((hi - p) / (hi - lo)) * PH;
  const inR = (p: number) => p >= lo && p <= hi;

  const lines: { p: number; label: string; cls: string; dash: string }[] = [];
  if (on.has('profile') && d.profile) {
    lines.push({ p: d.profile.poc, label: 'POC', cls: 'l-poc', dash: '0' }, { p: d.profile.vah, label: 'VAH', cls: 'l-lvl', dash: '2 4' }, { p: d.profile.val, label: 'VAL', cls: 'l-lvl', dash: '2 4' });
    d.profile.hvns.forEach((p) => lines.push({ p, label: 'HVN', cls: 'l-lvl', dash: '1 5' }));
  }
  const visible = lines.filter((l) => inR(l.p));
  const labels = spreadLabels(visible.map((l) => ({ y: y(l.p), text: `${l.label} ${fmtPrice(l.p)}` })), 12, MT + 6, MT + PH - 2);
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / 5);
  const timeTicks = Array.from({ length: 6 }, (_, i) => fromTs + (span * i) / 5);

  const maxNotional = Math.max(1, ...d.bigTrades.map((b) => b.notional));
  const cvdVals = candles.map((c) => c.cvd);
  const cMin = Math.min(...cvdVals), cMax = Math.max(...cvdVals);
  const dMax = Math.max(1e-9, ...candles.map((c) => Math.abs(c.delta)));
  const top2 = MT + PH + GAP, mid2 = top2 + DH / 2;
  const yc = (v: number) => top2 + 4 + ((cMax - v) / Math.max(1e-9, cMax - cMin)) * (DH - 8);

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${d.symbol} ${d.tf} chart with order-flow overlays`}>
      {ticks.map((p) => <line key={p} x1={ML} x2={W - MR} y1={y(p)} y2={y(p)} stroke="var(--grid)" />)}
      {ticks.filter((p) => visible.every((l) => Math.abs(y(l.p) - y(p)) > 14)).map((p) => <text key={p} x={W - MR + 4} y={y(p) + 4}>{fmtPrice(p)}</text>)}
      {timeTicks.map((t, i) => <text key={t} x={x(t)} y={H - 8} textAnchor={i === 0 ? 'start' : i === timeTicks.length - 1 ? 'end' : 'middle'}>{new Date(t).toISOString().slice(11, 16)}</text>)}
      {on.has('walls') && d.walls.filter((w) => inR(w.price)).map((w, i) => (
        <line key={`w${i}`} x1={x(Math.max(w.firstSeen, fromTs))} x2={x(Math.min(w.lastSeen, toTs))} y1={y(w.price)} y2={y(w.price)} className={w.side === 'bid' ? 'w-bid' : 'w-ask'}
          strokeWidth={Math.min(6, 2 + (3 * w.peak) / Math.max(1, ...d.walls.map((v) => v.peak)))} opacity={w.status === 'active' ? 0.7 : 0.35} strokeDasharray={w.status === 'active' ? '0' : '4 3'}><title>{w.side} wall {fmtPrice(w.price)} · peak {w.peak.toFixed(0)} · {w.status}</title></line>
      ))}
      {visible.map((l) => <line key={l.label + l.p} x1={ML} x2={W - MR} y1={y(l.p)} y2={y(l.p)} className={l.cls} strokeDasharray={l.dash} strokeWidth={1} opacity={0.85} />)}
      {on.has('gex') && d.gexFlip.length > 0 && (
        <polyline className="l-gex" fill="none" strokeWidth={1.5} strokeDasharray="6 3"
          points={d.gexFlip.filter((g) => inR(g.flip)).map((g) => `${x(g.ts)},${y(g.flip)}`).join(' ')}><title>GEX flip level</title></polyline>
      )}
      {candles.map((c) => {
        const cx = x(c.ts + step / 2);
        return (
          <g key={c.ts} className={c.close >= c.open ? 'c-up' : 'c-down'}>
            <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} strokeWidth={1} />
            <rect x={cx - cw / 2} width={cw} y={Math.min(y(c.open), y(c.close))} height={Math.max(1, Math.abs(y(c.open) - y(c.close)))} />
          </g>
        );
      })}
      {on.has('fp') && d.footprint.filter((e) => inR(e.lo) || inR(e.hi)).map((e, i) => {
        const cx = x(e.ts + step / 2);
        return (
          <g key={`f${i}`} className={e.direction === 'LONG' ? 'fp-long' : 'fp-short'}>
            <line x1={cx + cw / 2 + 2} x2={cx + cw / 2 + 2} y1={y(Math.min(e.hi, hi))} y2={y(Math.max(e.lo, lo))} strokeWidth={e.kind === 'absorption' ? 3 : 1.5} strokeDasharray={e.kind === 'absorption' ? '0' : '2 2'}>
              <title>{e.kind.replace('_', ' ')} → {e.direction} · {fmtPrice(e.lo)}–{fmtPrice(e.hi)}</title>
            </line>
          </g>
        );
      })}
      {on.has('big') && d.bigTrades.filter((b) => inR(b.price)).map((b, i) => (
        <circle key={`b${i}`} cx={x(b.ts)} cy={y(b.price)} r={2 + 7 * Math.sqrt(b.notional / maxNotional)} className={b.side > 0 ? 'bt-buy' : 'bt-sell'} opacity={0.5}>
          <title>{b.side > 0 ? 'buy' : 'sell'} {fmtPrice(b.price)} · ${(b.notional / 1e6).toFixed(2)}M</title>
        </circle>
      ))}
      {on.has('sig') && d.signals.map((s) => {
        const px = x(s.ts), py = inR(s.entry) ? y(s.entry) : MT + 8, up = s.direction === 'LONG';
        return (
          <a key={s.id} href={`/signals/${s.id}`}>
            <path d={up ? `M${px},${py - 9} l6,12 h-12 z` : `M${px},${py + 9} l6,-12 h-12 z`} className={up ? 'sig-long' : 'sig-short'}><title>{s.direction} signal · score {s.score} (open details)</title></path>
          </a>
        );
      })}
      {labels.map((l) => <text key={l.text + l.y} x={W - MR + 4} y={l.ly + 4}>{l.text}</text>)}
      {showCvd && (
        <g>
          <rect x={ML} y={top2} width={W - ML - MR} height={DH} fill="none" stroke="var(--grid)" />
          <line x1={ML} x2={W - MR} y1={mid2} y2={mid2} stroke="var(--grid)" />
          {candles.map((c) => {
            const h = (Math.abs(c.delta) / dMax) * (DH / 2 - 4);
            return <rect key={c.ts} x={x(c.ts + step / 2) - cw / 2} width={cw} y={c.delta >= 0 ? mid2 - h : mid2} height={Math.max(0.5, h)} fill={c.delta >= 0 ? 'var(--up)' : 'var(--down)'} opacity={0.45} />;
          })}
          <polyline fill="none" className="l-cvd" strokeWidth={1.5} points={candles.map((c) => `${x(c.ts + step / 2)},${yc(c.cvd)}`).join(' ')} />
          <text x={W - MR + 4} y={top2 + 12}>CVD</text>
          <text x={W - MR + 4} y={top2 + 26}>bars = delta</text>
        </g>
      )}
    </svg>
  );
}
