import type { Candle } from '../../src/core/types';
import { fmtPrice } from '../lib/format';
import { spreadLabels } from '../lib/labels';

export interface ChartLevel { price: number; label: string }
export interface ChartMarker { ts: number; label: string; cls?: string }
export interface ChartPlan { direction: 'LONG' | 'SHORT'; entry: number; entryLo: number; entryHi: number; stop: number; t1: number; t2: number }

const W = 1000, H = 420, ML = 8, MR = 108, MT = 10, MB = 26;

/** Server-rendered SVG candlesticks with the trade plan and profile levels overlaid. */
export function CandleChart({ candles, fromTs, toTs, levels = [], plan, markers = [], signalTs }: {
  candles: Candle[]; fromTs: number; toTs: number; levels?: ChartLevel[]; plan?: ChartPlan; markers?: ChartMarker[]; signalTs?: number;
}) {
  if (!candles.length) return <div className="notice mut">No price data around this signal (trades were not stored for this period).</div>;
  const planPrices = plan ? [plan.stop, plan.t1, plan.t2, plan.entryLo, plan.entryHi] : [];
  let lo = Math.min(...candles.map((c) => c.low), ...planPrices), hi = Math.max(...candles.map((c) => c.high), ...planPrices);
  const pad = (hi - lo) * 0.04 || hi * 0.001;
  lo -= pad; hi += pad;
  const x = (ts: number) => ML + ((ts - fromTs) / Math.max(1, toTs - fromTs)) * (W - ML - MR);
  const y = (p: number) => MT + ((hi - p) / (hi - lo)) * (H - MT - MB);
  const step = candles.length > 1 ? candles[1].ts - candles[0].ts : 60_000;
  const cw = Math.max(1.5, ((W - ML - MR) * step) / Math.max(1, toTs - fromTs) * 0.7);
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / 5);
  const timeTicks = Array.from({ length: 6 }, (_, i) => fromTs + ((toTs - fromTs) * i) / 5);
  const visibleLevels = levels.filter((l) => l.price >= lo && l.price <= hi);
  const rules: { p: number; cls: string; dash: string; label: string }[] = [
    ...visibleLevels.map((l) => ({ p: l.price, cls: 'l-lvl', dash: '2 4', label: l.label })),
    ...(plan ? [
      { p: plan.stop, cls: 'l-stop', dash: '5 4', label: 'STOP' }, { p: plan.t1, cls: 'l-tp', dash: '5 4', label: 'T1' },
      { p: plan.t2, cls: 'l-tp', dash: '5 4', label: 'T2' }, { p: plan.entry, cls: 'l-lvl', dash: '0', label: 'ENTRY' },
    ] : []),
  ];
  // labels get spread vertically so coinciding levels (e.g. T1 on an HVN) stay readable
  const labels = spreadLabels([...rules.map((r) => ({ y: y(r.p), text: `${r.label} ${fmtPrice(r.p)}` })), ...ticks.filter((p) => rules.every((r) => Math.abs(y(r.p) - y(p)) > 14)).map((p) => ({ y: y(p), text: fmtPrice(p) }))], 12, MT + 6, H - MB - 2);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price chart with trade plan">
      {ticks.map((p) => <line key={p} x1={ML} x2={W - MR} y1={y(p)} y2={y(p)} stroke="var(--grid)" />)}
      {timeTicks.map((t, i) => (<text key={t} x={x(t)} y={H - 8} textAnchor={i === 0 ? 'start' : i === timeTicks.length - 1 ? 'end' : 'middle'}>{new Date(t).toISOString().slice(11, 16)}</text>))}
      {plan && <rect className="zone" x={ML} width={W - ML - MR} y={y(plan.entryHi)} height={Math.max(2, y(plan.entryLo) - y(plan.entryHi))} />}
      {rules.map((r) => <line key={r.label + r.p} x1={ML} x2={W - MR} y1={y(r.p)} y2={y(r.p)} className={r.cls} strokeDasharray={r.dash} strokeWidth={1} opacity={0.85} />)}
      {candles.map((c) => {
        const up = c.close >= c.open;
        const cls = up ? 'c-up' : 'c-down';
        const cx = x(c.ts + step / 2);
        return (
          <g key={c.ts} className={cls}>
            <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} strokeWidth={1} />
            <rect x={cx - cw / 2} width={cw} y={Math.min(y(c.open), y(c.close))} height={Math.max(1, Math.abs(y(c.open) - y(c.close)))} />
          </g>
        );
      })}
      {labels.map((l) => <text key={l.text + l.y} x={W - MR + 4} y={l.ly + 4}>{l.text}</text>)}
      {signalTs != null && <line x1={x(signalTs)} x2={x(signalTs)} y1={MT} y2={H - MB} stroke="var(--accent)" strokeDasharray="3 3" />}
      {markers.filter((m) => m.ts >= fromTs && m.ts <= toTs).map((m) => (
        <g key={m.label + m.ts}>
          <line x1={x(m.ts)} x2={x(m.ts)} y1={MT} y2={H - MB} stroke="var(--muted)" strokeDasharray="1 3" />
          <text x={x(m.ts) - 3} y={H - MB - 6} textAnchor="end">{m.label}</text>
        </g>
      ))}
    </svg>
  );
}
