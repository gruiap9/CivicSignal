import { useEffect, useRef } from 'react';
import { lanePoint } from '../core/network';
import { phaseOf } from '../core/network';
import { lightFor } from '../core/supervisor';
import { vehicleGroup, type Sim } from '../core/sim';
import { AVENUES, STREETS } from '../core/scenario';
import type { Group } from '../core/types';

const LANE_W = 3.2;
const WORLD = 480;
const COLORS = {
  bg: '#141413',
  block: '#1d1d1b',
  road: '#33332f',
  box: '#3a3a35',
  mark: '#55554e',
  car: '#d6d4cc',
  carStopped: '#f0a43a',
  bus: '#22b8a0',
  G: '#2fbf71',
  Y: '#f2c84b',
  R: '#e5484d',
  incident: '#ff7a1a',
  text: '#a8a69c',
  select: '#3987e5',
};

interface Props {
  getSim: () => Sim;
  selected: string | null;
  onSelect: (id: string) => void;
  title: string;
  accent: string;
}

/** Draws on its own animation-frame loop so React only re-renders panels, not every frame. */
export function NetworkCanvas({ getSim, selected, onSelect, title, accent }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sel = useRef(selected);
  sel.current = selected;

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const cv = ref.current;
      const box = wrap.current;
      if (cv && box) {
        const size = Math.max(240, Math.min(box.clientWidth, 560));
        const dpr = window.devicePixelRatio || 1;
        if (cv.width !== Math.round(size * dpr)) {
          cv.width = Math.round(size * dpr);
          cv.height = Math.round(size * dpr);
          cv.style.width = `${size}px`;
          cv.style.height = `${size}px`;
        }
        const ctx = cv.getContext('2d')!;
        ctx.setTransform((size * dpr) / WORLD, 0, 0, (size * dpr) / WORLD, 0, 0);
        draw(ctx, getSim(), sel.current);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [getSim]);

  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * WORLD;
    const y = ((e.clientY - r.top) / r.height) * WORLD;
    let best: string | null = null;
    let bd = 30;
    const net = getSim().net;
    for (const id of net.signals) {
      const n = net.nodes[id];
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    if (best) onSelect(best);
  };

  return (
    <div className="net-wrap" ref={wrap}>
      <div className="net-title" style={{ borderColor: accent }}>
        <span className="swatch" style={{ background: accent }} />
        {title}
      </div>
      <canvas ref={ref} onClick={click} aria-label={`${title} network view. Click an intersection to inspect it.`} />
    </div>
  );
}

function draw(ctx: CanvasRenderingContext2D, sim: Sim, selected: string | null) {
  const net = sim.net;
  const st = sim.state;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, WORLD, WORLD);

  // Roads: each directed link paints its own half of the street.
  const half = (net.links[net.entries[0]].lanes.L + net.links[net.entries[0]].lanes.TR) * LANE_W;
  for (const l of Object.values(net.links)) {
    const L = l.length || 1;
    const dx = (l.x1 - l.x0) / L;
    const dy = (l.y1 - l.y0) / L;
    const nx = -dy * half;
    const ny = dx * half;
    ctx.fillStyle = COLORS.road;
    ctx.beginPath();
    ctx.moveTo(l.x0, l.y0);
    ctx.lineTo(l.x1, l.y1);
    ctx.lineTo(l.x1 + nx, l.y1 + ny);
    ctx.lineTo(l.x0 + nx, l.y0 + ny);
    ctx.fill();
    // closed lanes
    const ls = st.links[l.id];
    if (ls.closedTR > 0) {
      ctx.fillStyle = 'rgba(255,122,26,0.35)';
      for (let k = 0; k < ls.closedTR; k++) {
        const lane = l.lanes.TR - 1 - k;
        const a = lanePoint(l, 'TR', lane, L * 0.15, LANE_W);
        const b = lanePoint(l, 'TR', lane, L * 0.85, LANE_W);
        ctx.save();
        ctx.translate(a.x, a.y);
        ctx.rotate(Math.atan2(dy, dx));
        ctx.fillRect(0, -LANE_W / 2, Math.hypot(b.x - a.x, b.y - a.y), LANE_W);
        ctx.restore();
      }
    }
  }
  // centre lines
  ctx.strokeStyle = COLORS.mark;
  ctx.lineWidth = 0.4;
  for (const l of Object.values(net.links)) {
    ctx.beginPath();
    ctx.moveTo(l.x0, l.y0);
    ctx.lineTo(l.x1, l.y1);
    ctx.stroke();
  }
  // intersection boxes
  for (const id of net.signals) {
    const n = net.nodes[id];
    ctx.fillStyle = COLORS.box;
    ctx.fillRect(n.x - net.boxHalf, n.y - net.boxHalf, net.boxHalf * 2, net.boxHalf * 2);
  }

  // Street labels
  ctx.fillStyle = COLORS.text;
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  AVENUES.forEach((a, c) => {
    const n = net.nodes[`I0${c}`];
    ctx.save();
    ctx.translate(n.x + 13.5, 60);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(a.replace('SW ', ''), 0, 0);
    ctx.restore();
  });
  ctx.textAlign = 'left';
  STREETS.forEach((s, r) => {
    const n = net.nodes[`I${r}0`];
    ctx.fillText(s.replace('SW ', ''), 8, n.y - 12);
  });

  // Signal heads at each stop line: one bar per lane group.
  for (const id of net.signals) {
    const sig = st.signals[id];
    for (const lid of net.inLinks[id]) {
      const l = net.links[lid];
      for (const g of ['L', 'TR'] as Group[]) {
        const c = lightFor(sig, phaseOf(l.heading, g));
        ctx.strokeStyle = COLORS[c];
        ctx.lineWidth = 1.6;
        const lanes = l.lanes[g];
        const a = lanePoint(l, g, 0, l.length, LANE_W);
        const b = lanePoint(l, g, lanes - 1, l.length, LANE_W);
        ctx.beginPath();
        ctx.moveTo(a.x + a.dy * LANE_W * 0.45 + a.dx, a.y - a.dx * LANE_W * 0.45 + a.dy);
        ctx.lineTo(b.x - b.dy * LANE_W * 0.45 + b.dx, b.y + b.dx * LANE_W * 0.45 + b.dy);
        ctx.stroke();
      }
    }
    if (id === selected) {
      const n = net.nodes[id];
      ctx.strokeStyle = COLORS.select;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(n.x - 16, n.y - 16, 32, 32);
      ctx.setLineDash([]);
    }
  }

  // Vehicles
  const flash = Math.floor(st.t * 2) % 2 === 0;
  const emsSpots: { x: number; y: number }[] = [];
  for (const l of Object.values(net.links)) {
    const ls = st.links[l.id];
    for (const g of ['L', 'TR'] as Group[]) {
      ls.q[g].forEach((lane, li) => {
        for (const v of lane) {
          const p = lanePoint(l, g, li, v.x, LANE_W);
          if (v.kind === 'ems') emsSpots.push({ x: p.x - p.dx * v.len * 0.5, y: p.y - p.dy * v.len * 0.5 });
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(Math.atan2(p.dy, p.dx));
          if (v.kind === 'ems') ctx.fillStyle = flash ? '#ff3b3b' : '#4d8dff';
          else if (v.kind === 'bus') ctx.fillStyle = COLORS.bus;
          else ctx.fillStyle = v.stopped ? COLORS.carStopped : COLORS.car;
          const w = v.kind === 'car' ? 1.9 : 2.5;
          ctx.fillRect(-v.len, -w / 2, v.len - 0.6, w);
          if (v.kind === 'ems') {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 0.5;
            ctx.strokeRect(-v.len, -w / 2, v.len - 0.6, w);
          }
          ctx.restore();
        }
      });
    }
  }

  // Emergency vehicles waiting at the network edge still get a ring.
  for (const e of net.entries)
    for (const v of st.backlog[e])
      if (v.kind === 'ems') {
        const l = net.links[e];
        emsSpots.push({ x: l.x0, y: l.y0 });
      }

  // Glowing, pulsing ring so the emergency vehicle is easy to follow. Pulses on wall-clock
  // time so it stays visible while paused.
  const pulse = (performance.now() % 1200) / 1200;
  for (const s of emsSpots) {
    const glow = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, 22);
    glow.addColorStop(0, 'rgba(255,70,70,0.45)');
    glow.addColorStop(1, 'rgba(255,70,70,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,90,90,${(1 - pulse).toFixed(2)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 10 + pulse * 14, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Network-edge backlog (vehicles that could not enter because the entry link is full).
  ctx.font = 'bold 9px system-ui, sans-serif';
  for (const e of net.entries) {
    const n = st.backlog[e].length;
    if (!n) continue;
    const l = net.links[e];
    ctx.fillStyle = COLORS.R;
    const x = Math.min(WORLD - 30, Math.max(4, l.x0 + (l.heading === 'W' ? -26 : l.heading === 'E' ? 2 : 4)));
    const y = Math.min(WORLD - 4, Math.max(10, l.y0 + (l.heading === 'S' ? 10 : l.heading === 'N' ? -4 : -6)));
    ctx.fillText(`+${n}`, x, y);
  }

  // Incident markers
  for (const c of st.closures) {
    const l = net.links[c.link];
    const p = lanePoint(l, 'TR', l.lanes.TR - 1, l.length * 0.5, LANE_W);
    ctx.fillStyle = COLORS.incident;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 6);
    ctx.lineTo(p.x + 5.5, p.y + 4);
    ctx.lineTo(p.x - 5.5, p.y + 4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#141413';
    ctx.font = 'bold 7px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(c.kind === 'incident' ? '!' : 'R', p.x, p.y + 3);
    ctx.textAlign = 'left';
  }

  // EMS route highlight
  for (const v of sim.allVehicles()) {
    if (v.kind !== 'ems') continue;
    ctx.strokeStyle = 'rgba(255,59,59,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let k = v.ri; k < v.route.length; k++) {
      const l = net.links[v.route[k]];
      const a = lanePoint(l, vehicleGroup(net, v, k), 0, 0, LANE_W);
      const b = lanePoint(l, vehicleGroup(net, v, k), 0, l.length, LANE_W);
      if (k === v.ri) ctx.moveTo(a.x, a.y);
      else ctx.lineTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
