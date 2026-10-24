// Replaceable traffic source. It produces identical arrival lists for both
// controller copies; a SUMO or camera-count adapter could implement the same
// `TrafficSource` interface later.

import { hashSeed, Rng } from './rng';
import { LEFT_OF, RIGHT_OF } from './network';
import { nodesToRoute, type BusLine, type DemandProfile } from './scenario';
import type { Heading, Network, Turn, VehicleKind } from './types';

export interface Arrival {
  id: number;
  kind: VehicleKind;
  route: string[];
  spawnT: number;
  pax: number;
  lateness0: number;
  label?: string;
}

export interface TrafficSource {
  step(t: number, dt: number): Arrival[];
  applySurge(entries: string[], factor: number, until: number, t: number): void;
}

interface Stream {
  entry: string;
  kind: 'car' | 'bus';
  rate: number; // veh/s
  arrRng: Rng;
  routeRng: Rng;
  next: number;
}

const MAX_SIGNALS = 8;
const OPPOSITE: Record<Heading, Heading> = { N: 'S', S: 'N', E: 'W', W: 'E' };

export class SeededDemand implements TrafficSource {
  private streams: Stream[] = [];
  private surges = new Map<string, { factor: number; until: number }>();
  private busNext: number[];
  private busRng: Rng;
  private nextId = 1;
  private net: Network;
  private profile: DemandProfile;
  private busLines: BusLine[];
  private duration: number;

  constructor(net: Network, profile: DemandProfile, busLines: BusLine[], seed: number, duration: number) {
    this.net = net;
    this.profile = profile;
    this.busLines = busLines;
    this.duration = duration;
    const add = (entry: string, kind: 'car' | 'bus', vph: number) => {
      if (!(vph > 0) || !net.links[entry]) return;
      // One RNG stream per entry and vehicle type, so a surge on one approach never shifts arrivals elsewhere.
      const arrRng = new Rng(hashSeed(seed, 'arr', kind, entry));
      const rate = vph / 3600;
      this.streams.push({ entry, kind, rate, arrRng, routeRng: new Rng(hashSeed(seed, 'route', kind, entry)), next: arrRng.exp(rate) });
    };
    for (const [entry, vph] of Object.entries(profile.entries).sort()) add(entry, 'car', vph);
    for (const [entry, vph] of Object.entries(profile.busEntries ?? {}).sort()) add(entry, 'bus', vph);
    this.busRng = new Rng(hashSeed(seed, 'bus'));
    this.busNext = busLines.map((b) => b.offset);
  }

  private rateOf(s: Stream, t: number) {
    const sg = this.surges.get(s.entry);
    return sg && t < sg.until ? s.rate * sg.factor : s.rate;
  }

  applySurge(entries: string[], factor: number, until: number, t: number) {
    for (const e of entries) {
      this.surges.set(e, { factor, until });
      // Poisson is memoryless, so redrawing the next arrival at the new rate is exact.
      for (const s of this.streams) if (s.entry === e) s.next = t + s.arrRng.exp(this.rateOf(s, t));
    }
  }

  step(t: number, dt: number): Arrival[] {
    const out: Arrival[] = [];
    if (t >= this.duration) return out;
    const end = Math.min(t + dt, this.duration);
    for (const s of this.streams) {
      while (s.next < end) {
        const bus = s.kind === 'bus';
        out.push({
          id: this.nextId++,
          kind: s.kind,
          route: this.makeRoute(s.entry, s.routeRng, bus),
          spawnT: s.next,
          pax: bus ? this.busRng.int(8, 60) : 1,
          lateness0: bus ? this.busRng.int(-60, 180) : 0,
          label: bus ? 'Bus (measured volume, generated load)' : undefined,
        });
        s.next += s.arrRng.exp(this.rateOf(s, s.next));
      }
    }
    this.busLines.forEach((line, i) => {
      while (this.busNext[i] < end) {
        out.push({
          id: this.nextId++,
          kind: 'bus',
          route: nodesToRoute(line.nodes),
          spawnT: this.busNext[i],
          pax: this.busRng.int(8, 60),
          lateness0: this.busRng.int(-60, 180),
          label: line.name,
        });
        this.busNext[i] += line.headway;
      }
    });
    return out;
  }

  /** Turn probabilities for an approach link, restricted to legs that exist (one-way streets). */
  private shares(link: string, bus: boolean): [Turn, number][] {
    const net = this.net;
    const l = net.links[link];
    const outs = net.out[l.to];
    const target: Record<Turn, Heading> = { L: LEFT_OF[l.heading], T: l.heading, R: RIGHT_OF[l.heading] };
    const measured = (bus ? this.profile.busTurns?.[link] : undefined) ?? this.profile.turns?.[link];
    const base: Record<Turn, number> = measured
      ? { L: measured.L ?? 0, T: measured.T ?? 0, R: measured.R ?? 0 }
      : { L: this.profile.turnL, T: 1 - this.profile.turnL - this.profile.turnR, R: this.profile.turnR };
    let opts = (['L', 'T', 'R'] as Turn[]).filter((k) => outs[target[k]] && base[k] > 0).map((k) => [k, base[k]] as [Turn, number]);
    if (!opts.length) opts = (['T', 'R', 'L'] as Turn[]).filter((k) => outs[target[k]]).map((k) => [k, 1] as [Turn, number]);
    const sum = opts.reduce((a, [, v]) => a + v, 0);
    return opts.map(([k, v]) => [k, v / sum]);
  }

  private makeRoute(entry: string, rng: Rng, bus: boolean): string[] {
    const net = this.net;
    const route = [entry];
    let link = net.links[entry];
    let signals = 0;
    while (net.nodes[link.to].kind === 'signal') {
      signals++;
      const outs = net.out[link.to];
      let next: string | undefined;
      if (signals > MAX_SIGNALS) {
        // Safety valve against loops: leave the network if possible.
        const legal = (Object.entries(outs) as [Heading, string][]).filter(([h]) => h !== OPPOSITE[link.heading]).map(([, id]) => id);
        next = legal.find((id) => net.nodes[net.links[id].to].kind === 'boundary') ?? legal[0];
      } else {
        const u = rng.next();
        let acc = 0;
        const opts = this.shares(link.id, bus);
        let turn = opts[opts.length - 1][0];
        for (const [k, p] of opts) {
          acc += p;
          if (u < acc) {
            turn = k;
            break;
          }
        }
        const h = turn === 'L' ? LEFT_OF[link.heading] : turn === 'R' ? RIGHT_OF[link.heading] : link.heading;
        next = outs[h];
      }
      route.push(next!);
      link = net.links[next!];
    }
    return route;
  }

  /** Expected movement volumes (veh/h) by Monte-Carlo sampling of routes — used to tune the baseline. */
  static expectedMovementFlows(net: Network, profile: DemandProfile, busLines: BusLine[], samplesPerEntry = 3000) {
    const flows: Record<string, number> = {}; // key `${linkIn}|${linkOut}`
    const gen = new SeededDemand(net, profile, [], 987654321, 0);
    for (const s of gen.streams) {
      const vph = s.rate * 3600;
      for (let k = 0; k < samplesPerEntry; k++) {
        const r = gen.makeRoute(s.entry, s.routeRng, s.kind === 'bus');
        for (let i = 0; i < r.length - 1; i++) {
          const key = `${r[i]}|${r[i + 1]}`;
          flows[key] = (flows[key] ?? 0) + vph / samplesPerEntry;
        }
      }
    }
    for (const line of busLines) {
      const r = nodesToRoute(line.nodes);
      for (let i = 0; i < r.length - 1; i++) {
        const key = `${r[i]}|${r[i + 1]}`;
        flows[key] = (flows[key] ?? 0) + 3600 / line.headway;
      }
    }
    return flows;
  }
}
