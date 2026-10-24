import type { Group, Heading, NetLink, NetNode, Network, PhaseId, Turn } from './types';

export const LEFT_OF: Record<Heading, Heading> = { N: 'W', W: 'S', S: 'E', E: 'N' };
export const RIGHT_OF: Record<Heading, Heading> = { N: 'E', E: 'S', S: 'W', W: 'N' };
const VEC: Record<Heading, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

export function turnBetween(a: Heading, b: Heading): Turn {
  if (a === b) return 'T';
  if (LEFT_OF[a] === b) return 'L';
  if (RIGHT_OF[a] === b) return 'R';
  throw new Error(`U-turn ${a}->${b} not allowed`);
}

export function groupOf(turn: Turn): Group {
  return turn === 'L' ? 'L' : 'TR';
}

export function phaseOf(approach: Heading, group: Group): PhaseId {
  const ns = approach === 'N' || approach === 'S';
  if (group === 'L') return ns ? 0 : 2;
  return ns ? 1 : 3;
}

export interface GridSpec {
  avenues: string[]; // N–S streets, west → east
  streets: string[]; // E–W streets, north → south
  spacing: number; // centre-to-centre (m)
  approach: number; // boundary → first signal (m)
  vf: number;
  lanes: Record<Group, number>;
}

export const BOX_HALF = 10;

/** Build a rectangular signalised grid with boundary sources/sinks on every edge. */
export function buildGrid(spec: GridSpec): Network {
  const nodes: Record<string, NetNode> = {};
  const links: Record<string, NetLink> = {};
  const out: Network['out'] = {};
  const inLinks: Network['inLinks'] = {};
  const signals: string[] = [];
  const entries: string[] = [];
  const R = spec.streets.length;
  const C = spec.avenues.length;
  const ox = spec.approach;
  const oy = spec.approach;

  const sig = (r: number, c: number) => `I${r}${c}`;
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const id = sig(r, c);
      nodes[id] = {
        id,
        kind: 'signal',
        x: ox + c * spec.spacing,
        y: oy + r * spec.spacing,
        name: `${spec.avenues[c]} & ${spec.streets[r]}`,
      };
      signals.push(id);
    }
  const W = ox * 2 + (C - 1) * spec.spacing;
  const H = oy * 2 + (R - 1) * spec.spacing;
  const bnd = (id: string, x: number, y: number) => (nodes[id] = { id, kind: 'boundary', x, y });
  for (let c = 0; c < C; c++) {
    bnd(`BN${c}`, ox + c * spec.spacing, 0);
    bnd(`BS${c}`, ox + c * spec.spacing, H);
  }
  for (let r = 0; r < R; r++) {
    bnd(`BW${r}`, 0, oy + r * spec.spacing);
    bnd(`BE${r}`, W, oy + r * spec.spacing);
  }

  const addLink = (from: string, to: string, name: string) => {
    const a = nodes[from];
    const b = nodes[to];
    const dx = Math.sign(b.x - a.x);
    const dy = Math.sign(b.y - a.y);
    const heading: Heading = dx > 0 ? 'E' : dx < 0 ? 'W' : dy > 0 ? 'S' : 'N';
    const [vx, vy] = VEC[heading];
    const ha = a.kind === 'signal' ? BOX_HALF : 0;
    const hb = b.kind === 'signal' ? BOX_HALF : 0;
    const x0 = a.x + vx * ha;
    const y0 = a.y + vy * ha;
    const x1 = b.x - vx * hb;
    const y1 = b.y - vy * hb;
    const id = `${from}>${to}`;
    links[id] = {
      id,
      from,
      to,
      heading,
      length: Math.hypot(x1 - x0, y1 - y0),
      lanes: { ...spec.lanes },
      vf: spec.vf,
      name: `${name} ${heading}B`,
      x0,
      y0,
      x1,
      y1,
    };
    (out[from] ??= {})[heading] = id;
    (inLinks[to] ??= []).push(id);
    if (a.kind === 'boundary') entries.push(id);
  };

  for (let c = 0; c < C; c++) {
    const av = spec.avenues[c];
    addLink(`BN${c}`, sig(0, c), av);
    addLink(sig(0, c), `BN${c}`, av);
    addLink(`BS${c}`, sig(R - 1, c), av);
    addLink(sig(R - 1, c), `BS${c}`, av);
    for (let r = 0; r < R - 1; r++) {
      addLink(sig(r, c), sig(r + 1, c), av);
      addLink(sig(r + 1, c), sig(r, c), av);
    }
  }
  for (let r = 0; r < R; r++) {
    const st = spec.streets[r];
    addLink(`BW${r}`, sig(r, 0), st);
    addLink(sig(r, 0), `BW${r}`, st);
    addLink(`BE${r}`, sig(r, C - 1), st);
    addLink(sig(r, C - 1), `BE${r}`, st);
    for (let c = 0; c < C - 1; c++) {
      addLink(sig(r, c), sig(r, c + 1), st);
      addLink(sig(r, c + 1), sig(r, c), st);
    }
  }
  return { nodes, links, signals, out, inLinks, entries, boxHalf: BOX_HALF, tilt: 0 };
}

// ---------- Real networks (generated from OpenStreetMap by research/scripts/build_kendall.py) ----------

export interface NetworkSpec {
  gridTilt: number;
  boundaryLength: number;
  signals: { id: string; name: string; x: number; y: number }[];
  links: { from: string; to: string; street: string; pathLength: number; lanes: number; vf: number; heading: Heading }[];
  boundary: { signal: string; side: Heading; dir: 'entry' | 'exit'; street: string; lanes: number; vf: number }[];
}

const OPP: Record<Heading, Heading> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** Unit vector (x east, y south) of a grid heading in a grid rotated `tilt` degrees clockwise. */
export function headingVector(h: Heading, tilt: number): [number, number] {
  const bearing = (({ N: 0, E: 90, S: 180, W: 270 } as const)[h] + tilt) * (Math.PI / 180);
  return [Math.sin(bearing), -Math.cos(bearing)];
}

export const boundaryNodeId = (signal: string, side: Heading) => `B${signal}${side}`;

export function buildFromSpec(spec: NetworkSpec): Network {
  const nodes: Record<string, NetNode> = {};
  const links: Record<string, NetLink> = {};
  const out: Network['out'] = {};
  const inLinks: Network['inLinks'] = {};
  const entries: string[] = [];
  for (const s of spec.signals) nodes[s.id] = { id: s.id, kind: 'signal', x: s.x, y: s.y, name: s.name };
  for (const b of spec.boundary) {
    const id = boundaryNodeId(b.signal, b.side);
    if (nodes[id]) continue;
    const s = nodes[b.signal];
    const [vx, vy] = headingVector(b.side, spec.gridTilt);
    nodes[id] = { id, kind: 'boundary', x: s.x + vx * spec.boundaryLength, y: s.y + vy * spec.boundaryLength };
  }
  const add = (from: string, to: string, heading: Heading, length: number, lanes: number, vf: number, street: string) => {
    const a = nodes[from];
    const b = nodes[to];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const ha = a.kind === 'signal' ? BOX_HALF : 0;
    const hb = b.kind === 'signal' ? BOX_HALF : 0;
    const id = `${from}>${to}`;
    links[id] = {
      id,
      from,
      to,
      heading,
      // Simulated length is the real street path; the drawing is a straight segment between nodes.
      length: Math.max(20, length - ha - hb),
      lanes: { L: 1, TR: Math.max(1, lanes - 1) },
      vf,
      name: `${street} ${heading}B`,
      x0: a.x + ux * ha,
      y0: a.y + uy * ha,
      x1: b.x - ux * hb,
      y1: b.y - uy * hb,
    };
    if ((out[from] ??= {})[heading]) throw new Error(`${from} has two outgoing ${heading} links`);
    out[from][heading] = id;
    (inLinks[to] ??= []).push(id);
    if (a.kind === 'boundary') entries.push(id);
  };
  for (const l of spec.links) add(l.from, l.to, l.heading, l.pathLength, l.lanes, l.vf, l.street);
  for (const b of spec.boundary) {
    const bn = boundaryNodeId(b.signal, b.side);
    if (b.dir === 'entry') add(bn, b.signal, OPP[b.side], spec.boundaryLength, b.lanes, b.vf, b.street);
    else add(b.signal, bn, b.side, spec.boundaryLength, b.lanes, b.vf, b.street);
  }
  return { nodes, links, signals: spec.signals.map((s) => s.id), out, inLinks, entries, boxHalf: BOX_HALF, tilt: spec.gridTilt };
}

/** Position + direction of a point `x` metres along a link, offset into `lane`. */
export function lanePoint(link: NetLink, group: Group, lane: number, x: number, laneW: number) {
  const L = link.length || 1;
  const f = Math.min(1, Math.max(0, x / L));
  const px = link.x0 + (link.x1 - link.x0) * f;
  const py = link.y0 + (link.y1 - link.y0) * f;
  const dx = (link.x1 - link.x0) / L;
  const dy = (link.y1 - link.y0) / L;
  // right-hand traffic: lanes to the right of the centreline; left group is innermost
  const idx = group === 'L' ? 0 : link.lanes.L + lane;
  const off = (idx + 0.5) * laneW;
  return { x: px - dy * off, y: py + dx * off, dx, dy };
}

export function isExit(net: Network, linkId: string) {
  return net.nodes[net.links[linkId].to].kind === 'boundary';
}
