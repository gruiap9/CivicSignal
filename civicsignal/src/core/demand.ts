// Replaceable traffic source. It produces identical arrival lists for both
// controller copies; a SUMO or camera-count adapter could implement the same
// `TrafficSource` interface later.

import { hashSeed, Rng } from './rng';
import { LEFT_OF, RIGHT_OF } from './network';
import { BUS_LINES, nodesToRoute, type DemandProfile, type Side, entryLinkId } from './scenario';
import type { Heading, Network, VehicleKind } from './types';

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
  rate: number; // veh/s
  arrRng: Rng;
  routeRng: Rng;
  next: number;
}

export class SeededDemand implements TrafficSource {
  private streams: Stream[] = [];
  private surges = new Map<string, { factor: number; until: number }>();
  private busNext: number[];
  private busRng: Rng;
  private nextId = 1;
  private net: Network;
  private profile: DemandProfile;
  private duration: number;

  constructor(net: Network, profile: DemandProfile, seed: number, duration: number) {
    this.net = net;
    this.profile = profile;
    this.duration = duration;
    for (const side of ['N', 'S', 'E', 'W'] as Side[]) {
      profile.rates[side].forEach((vph, i) => {
        const entry = entryLinkId(side, i);
        // One RNG stream per entry so a surge on one approach never shifts arrivals elsewhere.
        const arrRng = new Rng(hashSeed(seed, 'arr', entry));
        const rate = vph / 3600;
        this.streams.push({ entry, rate, arrRng, routeRng: new Rng(hashSeed(seed, 'route', entry)), next: arrRng.exp(rate) });
      });
    }
    this.busRng = new Rng(hashSeed(seed, 'bus'));
    this.busNext = BUS_LINES.map((b) => b.offset);
  }

  private rateOf(s: Stream, t: number) {
    const sg = this.surges.get(s.entry);
    return sg && t < sg.until ? s.rate * sg.factor : s.rate;
  }

  applySurge(entries: string[], factor: number, until: number, t: number) {
    for (const e of entries) {
      this.surges.set(e, { factor, until });
      const s = this.streams.find((x) => x.entry === e);
      // Poisson is memoryless, so redrawing the next arrival at the new rate is exact.
      if (s) s.next = t + s.arrRng.exp(this.rateOf(s, t));
    }
  }

  step(t: number, dt: number): Arrival[] {
    const out: Arrival[] = [];
    if (t >= this.duration) return out;
    const end = Math.min(t + dt, this.duration);
    for (const s of this.streams) {
      while (s.next < end) {
        out.push({ id: this.nextId++, kind: 'car', route: this.makeRoute(s), spawnT: s.next, pax: 1, lateness0: 0 });
        s.next += s.arrRng.exp(this.rateOf(s, s.next));
      }
    }
    BUS_LINES.forEach((line, i) => {
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

  private makeRoute(s: Stream): string[] {
    const net = this.net;
    const route = [s.entry];
    let link = net.links[s.entry];
    let signals = 0;
    while (net.nodes[link.to].kind === 'signal') {
      signals++;
      const u = s.routeRng.next();
      let h: Heading = link.heading;
      if (signals <= 4) {
        if (u < this.profile.turnL) h = LEFT_OF[link.heading];
        else if (u < this.profile.turnL + this.profile.turnR) h = RIGHT_OF[link.heading];
      }
      const next = net.out[link.to][h]!;
      route.push(next);
      link = net.links[next];
    }
    return route;
  }

  /** Expected movement volumes (veh/h) by Monte-Carlo sampling of routes — used to tune the baseline. */
  static expectedMovementFlows(net: Network, profile: DemandProfile, samplesPerEntry = 3000) {
    const flows: Record<string, number> = {}; // key `${linkIn}|${linkOut}`
    const gen = new SeededDemand(net, profile, 987654321, 0);
    for (const s of gen.streams) {
      const vph = s.rate * 3600;
      for (let k = 0; k < samplesPerEntry; k++) {
        const r = gen.makeRoute(s);
        for (let i = 0; i < r.length - 1; i++) {
          const key = `${r[i]}|${r[i + 1]}`;
          flows[key] = (flows[key] ?? 0) + vph / samplesPerEntry;
        }
      }
    }
    for (const line of BUS_LINES) {
      const r = nodesToRoute(line.nodes);
      for (let i = 0; i < r.length - 1; i++) {
        const key = `${r[i]}|${r[i + 1]}`;
        flows[key] = (flows[key] ?? 0) + 3600 / line.headway;
      }
    }
    return flows;
  }
}
