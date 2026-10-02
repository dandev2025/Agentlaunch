'use client';
import { useEffect, useRef } from 'react';

export interface HeatmapProps {
  grid: { cols: number; rows: number; fromTs: number; toTs: number; pMin: number; pMax: number; bid: string; ask: string; scale: number };
  walls: { side: string; price: number; firstSeen: number; lastSeen: number; status: string; peak: number; executed: number }[];
  line: [number, number][];
}

const decode = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const MR = 64, MB = 22;
const WALL_COLOR: Record<string, string> = { active: '#ffffff', pulled: '#ff4dd2', eaten: '#ff5c5c', expired: '#8b97a8' };

/** Order-book heat map: bids (teal) and asks (amber) by resting size, with price line and wall lifecycles on top. */
export function HeatmapCanvas({ grid, walls, line }: HeatmapProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const bid = decode(grid.bid), ask = decode(grid.ask);
    const cssW = canvas.clientWidth || 1000, cssH = 480, dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr; canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0b0f14'; ctx.fillRect(0, 0, cssW, cssH);
    const pw = cssW - MR, ph = cssH - MB;

    // cells -> small offscreen image, then scaled up (blocky on purpose: each cell is a real time/price bucket)
    const off = document.createElement('canvas'); off.width = grid.cols; off.height = grid.rows;
    const octx = off.getContext('2d')!;
    const img = octx.createImageData(grid.cols, grid.rows);
    for (let i = 0; i < grid.cols * grid.rows; i++) {
      const b = bid[i], a = ask[i], v = Math.max(a, b);
      if (!v) continue;
      const t = Math.pow(v / 255, 0.6), c = a > b ? [240, 160, 75] : [53, 196, 176];
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = Math.round(30 + 225 * t);
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, pw, ph);

    const x = (ts: number) => ((ts - grid.fromTs) / (grid.toTs - grid.fromTs)) * pw;
    const y = (p: number) => ((grid.pMax - p) / (grid.pMax - grid.pMin)) * ph;
    // walls
    for (const w of walls) {
      ctx.strokeStyle = WALL_COLOR[w.status] ?? '#fff'; ctx.lineWidth = w.status === 'active' ? 2 : 1.5;
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.moveTo(Math.max(0, x(w.firstSeen)), y(w.price)); ctx.lineTo(Math.min(pw, x(w.lastSeen)), y(w.price)); ctx.stroke();
      if (w.status === 'pulled' || w.status === 'eaten') { const ex = Math.min(pw, x(w.lastSeen)); ctx.beginPath(); ctx.moveTo(ex, y(w.price) - 5); ctx.lineTo(ex, y(w.price) + 5); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    // price
    if (line.length > 1) {
      ctx.strokeStyle = '#e3e8ef'; ctx.lineWidth = 1.2; ctx.beginPath();
      line.forEach(([ts, p], i) => (i ? ctx.lineTo(x(ts), y(p)) : ctx.moveTo(x(ts), y(p))));
      ctx.stroke();
    }
    // axes
    ctx.fillStyle = '#8b97a8'; ctx.font = '11px ui-monospace, monospace';
    for (let i = 0; i <= 6; i++) {
      const p = grid.pMin + ((grid.pMax - grid.pMin) * i) / 6;
      ctx.fillText(p.toFixed(p >= 1000 ? 0 : p >= 100 ? 1 : 2), pw + 6, Math.min(ph - 2, Math.max(10, y(p) + 4)));
    }
    for (let i = 0; i <= 6; i++) {
      const ts = grid.fromTs + ((grid.toTs - grid.fromTs) * i) / 6;
      ctx.textAlign = i === 0 ? 'left' : i === 6 ? 'right' : 'center';
      ctx.fillText(new Date(ts).toISOString().slice(11, 16), (pw * i) / 6, cssH - 6);
    }
    ctx.textAlign = 'left';

    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const el = tip.current!;
      if (mx > pw || my > ph || mx < 0 || my < 0) { el.style.display = 'none'; return; }
      const col = Math.min(grid.cols - 1, Math.floor((mx / pw) * grid.cols)), row = Math.min(grid.rows - 1, Math.floor((my / ph) * grid.rows));
      const price = grid.pMax - (my / ph) * (grid.pMax - grid.pMin), ts = grid.fromTs + (mx / pw) * (grid.toTs - grid.fromTs);
      const i = row * grid.cols + col, b = bid[i], a = ask[i];
      const q = (v: number) => ((v / 255) * grid.scale).toFixed(1);
      el.textContent = `${new Date(ts).toISOString().slice(11, 19)}  ${price.toFixed(price >= 1000 ? 1 : 3)}  ${b ? `bid ≈${q(b)}` : a ? `ask ≈${q(a)}` : 'empty'}`;
      el.style.display = 'block'; el.style.left = `${Math.min(mx + 12, cssW - 230)}px`; el.style.top = `${my + 12}px`;
    };
    const onLeave = () => { if (tip.current) tip.current.style.display = 'none'; };
    canvas.addEventListener('mousemove', onMove); canvas.addEventListener('mouseleave', onLeave);
    return () => { canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('mouseleave', onLeave); };
  }, [grid, walls, line]);

  return (
    <div className="hm">
      <canvas ref={ref} aria-label="Order book heat map" />
      <div ref={tip} className="tip" />
    </div>
  );
}
