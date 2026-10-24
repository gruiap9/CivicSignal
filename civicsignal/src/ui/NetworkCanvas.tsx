import { useEffect, useRef } from 'react';
import { lanePoint, phaseOf } from '../core/network';
import { vehicleGroup, type Sim } from '../core/sim';
import { lightFor } from '../core/supervisor';
import type { Group, Network } from '../core/types';

const COLORS = {
  bg: '#141413',
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
const PAD = 14; // m around the network
const MAX_W = 560;
const MAX_H = 640;

interface Props {
  getSim: () => Sim;
  selected: string | null;
  onSelect: (id: string) => void;
  title: string;
  accent: string;
}

interface View {
  x0: number;
  y0: number;
  scale: number; // css px per metre
  w: number;
  h: number;
}

function bounds(net: Network) {
  const xs = Object.values(net.nodes).map((n) => n.x);
  const ys = Object.values(net.nodes).map((n) => n.y);
  return { x0: Math.min(...xs) - PAD, y0: Math.min(...ys) - PAD, x1: Math.max(...xs) + PAD, y1: Math.max(...ys) + PAD };
}

/** Draws on its own animation-frame loop so React only re-renders panels, not every frame. */
export function NetworkCanvas({ getSim, selected, onSelect, title, accent }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sel = useRef(selected);
  const view = useRef<View | null>(null);
  sel.current = selected;

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const cv = ref.current;
      const box = wrap.current;
      if (cv && box) {
        const sim = getSim();
        const b = bounds(sim.net);
        const ww = b.x1 - b.x0;
        const wh = b.y1 - b.y0;
        let w = Math.max(220, Math.min(box.clientWidth - 16, MAX_W));
        let h = (w * wh) / ww;
        if (h > MAX_H) {
          h = MAX_H;
          w = (h * ww) / wh;
        }
        const dpr = window.devicePixelRatio || 1;
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
          cv.width = Math.round(w * dpr);
          cv.height = Math.round(h * dpr);
          cv.style.width = `${w}px`;
          cv.style.height = `${h}px`;
        }
        const scale = w / ww;
        view.current = { x0: b.x0, y0: b.y0, scale, w, h };
        const ctx = cv.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(0, 0, w, h);
        ctx.setTransform(scale * dpr, 0, 0, scale * dpr, -b.x0 * scale * dpr, -b.y0 * scale * dpr);
        draw(ctx, sim, sel.current, scale);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [getSim]);

  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const v = view.current;
    if (!v) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = v.x0 + (e.clientX - r.left) / v.scale;
    const y = v.y0 + (e.clientY - r.top) / v.scale;
    let best: string | null = null;
    let bd = 24 / v.scale;
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

function draw(ctx: CanvasRenderingContext2D, sim: Sim, selected: string | null, scale: number) {
  const net = sim.net;
  const st = sim.state;
  const px = 1 / scale; // metres per screen pixel
  const lw = Math.max(3.2, 2.3 * px); // lane width: real 3.2 m, but never thinner than ~2.3 px on screen
  const links = Object.values(net.links);

  // Roads: each directed link paints its own half of the street.
  for (const l of links) {
    const half = (l.lanes.L + l.lanes.TR) * lw;
    const L = Math.hypot(l.x1 - l.x0, l.y1 - l.y0) || 1;
    const nx = (-(l.y1 - l.y0) / L) * half;
    const ny = ((l.x1 - l.x0) / L) * half;
    ctx.fillStyle = COLORS.road;
    ctx.beginPath();
    ctx.moveTo(l.x0, l.y0);
    ctx.lineTo(l.x1, l.y1);
    ctx.lineTo(l.x1 + nx, l.y1 + ny);
    ctx.lineTo(l.x0 + nx, l.y0 + ny);
    ctx.fill();
    const ls = st.links[l.id];
    if (ls.speedFactor < 1) {
      // Incident or roadwork: tint the affected half of the street.
      ctx.fillStyle = 'rgba(255,122,26,0.35)';
      ctx.fill();
    }
  }
  ctx.strokeStyle = COLORS.mark;
  ctx.lineWidth = 0.6 * px;
  for (const l of links) {
    ctx.beginPath();
    ctx.moveTo(l.x0, l.y0);
    ctx.lineTo(l.x1, l.y1);
    ctx.stroke();
  }
  const boxHalf = Math.max(net.boxHalf, 3 * lw);
  for (const id of net.signals) {
    const n = net.nodes[id];
    ctx.fillStyle = COLORS.box;
    ctx.fillRect(n.x - boxHalf, n.y - boxHalf, boxHalf * 2, boxHalf * 2);
  }

  // Street labels: once per street, along its longest link.
  const longest = new Map<string, (typeof links)[number]>();
  for (const l of links) {
    const name = l.name.replace(/ [NESW]B$/, '').replace(/^SW /, '');
    const cur = longest.get(name);
    if (!cur || Math.hypot(l.x1 - l.x0, l.y1 - l.y0) > Math.hypot(cur.x1 - cur.x0, cur.y1 - cur.y0)) longest.set(name, l);
  }
  ctx.fillStyle = COLORS.text;
  ctx.font = `${10 * px}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  for (const [name, l] of longest) {
    let ang = Math.atan2(l.y1 - l.y0, l.x1 - l.x0);
    if (ang > Math.PI / 2) ang -= Math.PI;
    if (ang < -Math.PI / 2) ang += Math.PI;
    const half = (l.lanes.L + l.lanes.TR) * lw;
    const mx = (l.x0 + l.x1) / 2;
    const my = (l.y0 + l.y1) / 2;
    const L = Math.hypot(l.x1 - l.x0, l.y1 - l.y0) || 1;
    // Sit just outside the road, on the side opposite the painted half.
    const ox = ((l.y1 - l.y0) / L) * (half * 0.2 + 5 * px);
    const oy = (-(l.x1 - l.x0) / L) * (half * 0.2 + 5 * px);
    ctx.save();
    ctx.translate(mx + ox, my + oy);
    ctx.rotate(ang);
    ctx.fillText(name.replace(' Street', ' St'), 0, 0);
    ctx.restore();
  }

  // Signal heads at each stop line: one bar per lane group.
  for (const id of net.signals) {
    const sig = st.signals[id];
    for (const lid of net.inLinks[id]) {
      const l = net.links[lid];
      for (const g of ['L', 'TR'] as Group[]) {
        ctx.strokeStyle = COLORS[lightFor(sig, phaseOf(l.heading, g))];
        ctx.lineWidth = Math.max(1.6, 1.5 * px);
        const a = lanePoint(l, g, 0, l.length, lw);
        const b = lanePoint(l, g, l.lanes[g] - 1, l.length, lw);
        ctx.beginPath();
        ctx.moveTo(a.x + a.dy * lw * 0.45, a.y - a.dx * lw * 0.45);
        ctx.lineTo(b.x - b.dy * lw * 0.45, b.y + b.dx * lw * 0.45);
        ctx.stroke();
      }
    }
    if (id === selected) {
      const n = net.nodes[id];
      const r = boxHalf + 5 * px;
      ctx.strokeStyle = COLORS.select;
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([3 * px, 2 * px]);
      ctx.strokeRect(n.x - r, n.y - r, 2 * r, 2 * r);
      ctx.setLineDash([]);
    }
  }

  // Vehicles
  const flash = Math.floor(st.t * 2) % 2 === 0;
  const emsSpots: { x: number; y: number }[] = [];
  for (const l of links) {
    const ls = st.links[l.id];
    for (const g of ['L', 'TR'] as Group[]) {
      ls.q[g].forEach((lane, li) => {
        for (const v of lane) {
          const p = lanePoint(l, g, li, v.x, lw);
          if (v.kind === 'ems') emsSpots.push({ x: p.x - p.dx * v.len * 0.5, y: p.y - p.dy * v.len * 0.5 });
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(Math.atan2(p.dy, p.dx));
          if (v.kind === 'ems') ctx.fillStyle = flash ? '#ff3b3b' : '#4d8dff';
          else if (v.kind === 'bus') ctx.fillStyle = COLORS.bus;
          else ctx.fillStyle = v.stopped ? COLORS.carStopped : COLORS.car;
          const w = lw * (v.kind === 'car' ? 0.6 : 0.8);
          const len = Math.max(v.len - 0.6, Math.min(6.4, 2.5 * px));
          ctx.fillRect(-len, -w / 2, len, w);
          ctx.restore();
        }
      });
    }
  }
  for (const e of net.entries)
    for (const v of st.backlog[e])
      if (v.kind === 'ems') emsSpots.push({ x: net.links[e].x0, y: net.links[e].y0 });

  // Network-edge backlog (vehicles that could not enter because the entry link is full).
  ctx.font = `bold ${10 * px}px system-ui, sans-serif`;
  ctx.fillStyle = COLORS.R;
  for (const e of net.entries) {
    const n = st.backlog[e].length;
    if (!n) continue;
    const l = net.links[e];
    ctx.fillText(`+${n}`, l.x0, l.y0 - 4 * px);
  }

  // Incident / roadwork markers
  for (const c of st.closures) {
    const l = net.links[c.link];
    const p = lanePoint(l, 'TR', l.lanes.TR - 1, l.length * 0.5, lw);
    const s = 6 * px;
    ctx.fillStyle = COLORS.incident;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - s);
    ctx.lineTo(p.x + s * 0.95, p.y + s * 0.7);
    ctx.lineTo(p.x - s * 0.95, p.y + s * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#141413';
    ctx.font = `bold ${7 * px}px system-ui, sans-serif`;
    ctx.fillText(c.kind === 'incident' ? '!' : 'R', p.x, p.y + s * 0.55);
  }

  // Emergency route + glowing, pulsing ring (pulses on wall-clock time so it shows while paused).
  for (const v of sim.allVehicles()) {
    if (v.kind !== 'ems') continue;
    ctx.strokeStyle = 'rgba(255,59,59,0.55)';
    ctx.lineWidth = 1.2 * px;
    ctx.setLineDash([4 * px, 3 * px]);
    ctx.beginPath();
    for (let k = v.ri; k < v.route.length; k++) {
      const l = net.links[v.route[k]];
      const a = lanePoint(l, vehicleGroup(net, v, k), 0, 0, lw);
      const b = lanePoint(l, vehicleGroup(net, v, k), 0, l.length, lw);
      if (k === v.ri) ctx.moveTo(a.x, a.y);
      else ctx.lineTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const pulse = (performance.now() % 1200) / 1200;
  for (const s of emsSpots) {
    const R = 22 * px;
    const glow = ctx.createRadialGradient(s.x, s.y, 2 * px, s.x, s.y, R);
    glow.addColorStop(0, 'rgba(255,70,70,0.45)');
    glow.addColorStop(1, 'rgba(255,70,70,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.2 * px;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 10 * px, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,90,90,${(1 - pulse).toFixed(2)})`;
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath();
    ctx.arc(s.x, s.y, (10 + pulse * 14) * px, 0, Math.PI * 2);
    ctx.stroke();
  }
}
