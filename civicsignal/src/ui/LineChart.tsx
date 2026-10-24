import { useState } from 'react';

export interface Series {
  name: string;
  color: string;
  points: [number, number][];
}

interface Props {
  title: string;
  unit: string;
  series: Series[];
  xLabel?: (x: number) => string;
  xMax?: number;
  height?: number;
  digits?: number;
}

const W = 360;
const PAD = { l: 38, r: 74, t: 8, b: 20 };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

export function LineChart({ title, unit, series, xLabel = (x) => fmtClock(x), xMax, height = 150, digits = 0 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const H = height;
  const all = series.flatMap((s) => s.points);
  const x1 = xMax ?? Math.max(1, ...all.map((p) => p[0]));
  const x0 = Math.min(...all.map((p) => p[0]), x1);
  const y1 = niceMax(Math.max(...all.map((p) => p[1]), 0) * 1.05);
  const sx = (x: number) => PAD.l + ((x - x0) / (x1 - x0 || 1)) * (W - PAD.l - PAD.r);
  const sy = (y: number) => H - PAD.b - (y / y1) * (H - PAD.t - PAD.b);
  const ticks = [0, y1 / 2, y1];

  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px < PAD.l || px > W - PAD.r) return setHover(null);
    setHover(x0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (x1 - x0));
  };
  const at = (s: Series, x: number) => {
    let best: [number, number] | null = null;
    for (const p of s.points) if (!best || Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p;
    return best;
  };

  return (
    <figure className="chart">
      <figcaption>
        {title} <span className="muted">({unit})</span>
      </figcaption>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} onPointerMove={move} onPointerLeave={() => setHover(null)} role="img" aria-label={title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} className="grid" />
            <text x={PAD.l - 5} y={sy(t) + 3} textAnchor="end" className="tick">
              {fmtNum(t)}
            </text>
          </g>
        ))}
        <text x={PAD.l} y={H - 5} className="tick">
          {xLabel(x0)}
        </text>
        <text x={W - PAD.r} y={H - 5} textAnchor="end" className="tick">
          {xLabel(x1)}
        </text>
        {series.map((s) => {
          if (!s.points.length) return null;
          const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('');
          const last = s.points[s.points.length - 1];
          return (
            <g key={s.name}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
              <text x={sx(last[0]) + 5} y={sy(last[1]) + 3} className="direct">
                {s.name.split(' ')[0]} {last[1].toFixed(digits)}
              </text>
            </g>
          );
        })}
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={sx(hover)} x2={sx(hover)} y1={PAD.t} y2={H - PAD.b} className="crosshair" />
            {series.map((s) => {
              const p = at(s, hover);
              return p ? <circle key={s.name} cx={sx(p[0])} cy={sy(p[1])} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} /> : null;
            })}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="tooltip">
          <b>{xLabel(hover)}</b>
          {series.map((s) => {
            const p = at(s, hover);
            return (
              <div key={s.name}>
                <i style={{ background: s.color }} />
                {s.name}: {p ? p[1].toFixed(digits) : '–'}
              </div>
            );
          })}
        </div>
      )}
    </figure>
  );
}

export function fmtClock(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtNum(v: number) {
  return v >= 10000 ? `${(v / 1000).toFixed(0)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v % 1 ? v.toFixed(1) : String(v);
}
