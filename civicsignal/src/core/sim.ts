// Microscopic-lite traffic simulator: vehicles follow a simple car-following
// rule within lanes, queue at stop lines, discharge at saturation headway when
// their movement is permitted, and can only enter a downstream lane with room
// (so spillback emerges naturally). State is plain data → cheap to clone.

import { groupOf, isExit, LEFT_OF, phaseOf, RIGHT_OF, turnBetween } from './network';
import { nodesToRoute, SIM_CONSTANTS, type EmsRoute } from './scenario';
import { initSignal, permits, tickSignal } from './supervisor';
import type { Arrival } from './demand';
import type {
  EmsSnap,
  Group,
  GroupSnap,
  LinkState,
  NetLink,
  Network,
  NetworkSnapshot,
  SignalSnap,
  SignalState,
  SimEvent,
  Vehicle,
} from './types';

const JAM_GAP = 2; // m between vehicles when stopped
const ACCEL = 2.5;
const TIME_GAP = 1.0;
const SCHEDULE_SLACK = 1.15; // bus schedules assume 15% slower than free flow

export interface EmsResult {
  id: number;
  label: string;
  spawnT: number;
  endT: number | null;
  freeFlow: number;
  stops: number;
  stoppedTime: number;
  nodeDelay: Record<string, number>;
}

export interface SeriesPoint {
  t: number;
  inNet: number;
  queued: number;
  avgDelay: number; // completed (counted) vehicles so far
  throughput: number;
  idle: number;
}

export interface MetricsState {
  spawned: number;
  completed: number;
  delaySum: number;
  stopsSum: number;
  idleSec: number;
  maxWait: number;
  maxWaitWhere: string;
  throughput: number;
  busCompleted: number;
  busDelaySum: number;
  busPaxDelaySum: number;
  /** Total delay of ALL non-emergency vehicles that completed (incl. warm-up) — used for EMS impact. */
  delayAllCompleted: number;
  series: SeriesPoint[];
}

export interface ActiveClosure {
  link: string;
  kind: 'incident' | 'roadwork';
  until: number;
  label: string;
  prevSpeed: number;
}

export interface SimState {
  t: number;
  step: number;
  links: Record<string, LinkState>;
  backlog: Record<string, Vehicle[]>;
  signals: Record<string, SignalState>;
  active: number;
  metrics: MetricsState;
  ems: Record<number, EmsResult>;
  closures: ActiveClosure[];
  /** Throughput counts trips completed in [warmup, measureEnd] (the demand window). */
  measureEnd: number;
  /** Non-emergency vehicles that crossed each link's stop line during [warmup, measureEnd] — what a sensor counts. */
  served: Record<string, number>;
}

export function vehicleGroup(net: Network, v: Vehicle, ri = v.ri): Group {
  const cur = net.links[v.route[ri]];
  const nxt = v.route[ri + 1];
  if (!nxt) return 'TR';
  return groupOf(turnBetween(cur.heading, net.links[nxt].heading));
}

export function storageOf(link: NetLink, group?: Group) {
  const perLane = Math.max(1, Math.floor(link.length / 7));
  if (group) return perLane * link.lanes[group];
  return perLane * (link.lanes.L + link.lanes.TR);
}

export class Sim {
  readonly net: Network;
  state: SimState;

  constructor(net: Network, state?: SimState) {
    this.net = net;
    this.state = state ?? Sim.initState(net);
  }

  static initState(net: Network): SimState {
    const links: Record<string, LinkState> = {};
    for (const l of Object.values(net.links)) {
      links[l.id] = {
        q: { L: Array.from({ length: l.lanes.L }, () => []), TR: Array.from({ length: l.lanes.TR }, () => []) },
        lastDis: { L: Array(l.lanes.L).fill(-99), TR: Array(l.lanes.TR).fill(-99) },
        closedTR: 0,
        speedFactor: 1,
      };
    }
    const signals: Record<string, SignalState> = {};
    for (const s of net.signals) signals[s] = initSignal(1);
    const backlog: Record<string, Vehicle[]> = {};
    for (const e of net.entries) backlog[e] = [];
    return {
      t: 0,
      step: 0,
      links,
      backlog,
      signals,
      active: 0,
      metrics: {
        spawned: 0,
        completed: 0,
        delaySum: 0,
        stopsSum: 0,
        idleSec: 0,
        maxWait: 0,
        maxWaitWhere: '',
        throughput: 0,
        busCompleted: 0,
        busDelaySum: 0,
        busPaxDelaySum: 0,
        delayAllCompleted: 0,
        series: [],
      },
      ems: {},
      closures: [],
      measureEnd: Infinity,
      served: {},
    };
  }

  clone(): Sim {
    return new Sim(this.net, structuredClone(this.state));
  }

  // ---------- inputs ----------

  inject(arrivals: Arrival[]) {
    for (const a of arrivals) {
      const v = this.makeVehicle(a.id, a.kind, a.route, a.spawnT);
      v.pax = a.pax;
      v.lateness0 = a.lateness0;
      v.label = a.label;
      v.counted = a.spawnT >= SIM_CONSTANTS.warmup;
      if (v.counted) this.state.metrics.spawned++;
      this.state.backlog[a.route[0]].push(v);
      this.state.active++;
    }
  }

  private makeVehicle(id: number, kind: Vehicle['kind'], route: string[], spawnT: number): Vehicle {
    return {
      id,
      kind,
      route,
      ri: 0,
      x: 0,
      v: 0,
      lane: 0,
      len: kind === 'bus' ? 12 : kind === 'ems' ? 8 : 5,
      spawnT,
      dist: 0,
      ffT: 0,
      idle: 0,
      stopRun: 0,
      maxStop: 0,
      stops: 0,
      stopped: false,
      counted: false,
      movedStep: -1,
      pax: 1,
      lateness0: 0,
    };
  }

  applyEvent(ev: SimEvent, emsId: number, emsRoute?: EmsRoute) {
    const s = this.state;
    if (ev.kind === 'incident' || ev.kind === 'roadwork') {
      const ls = s.links[ev.link];
      s.closures.push({ link: ev.link, kind: ev.kind, until: ev.t + ev.duration, label: ev.label, prevSpeed: ls.speedFactor });
      ls.closedTR = Math.min(this.net.links[ev.link].lanes.TR - 1, ls.closedTR + 1);
      ls.speedFactor = ev.kind === 'incident' ? 0.4 : 0.7;
    } else if (ev.kind === 'ems') {
      const r = emsRoute!;
      const route = nodesToRoute(r.nodes);
      const v = this.makeVehicle(emsId, 'ems', route, s.t);
      v.label = ev.vehicle === 'fire' ? 'Fire truck (simulated)' : 'Ambulance (simulated)';
      v.emsNodeDelay = {};
      let ff = 0;
      // Crossing the intersection box is instantaneous in this model, so free-flow uses link lengths only.
      for (const id of route) ff += this.net.links[id].length / (this.net.links[id].vf * 1.25);
      s.ems[emsId] = {
        id: emsId,
        label: `${v.label} — ${r.name}`,
        spawnT: s.t,
        endT: null,
        freeFlow: ff,
        stops: 0,
        stoppedTime: 0,
        nodeDelay: {},
      };
      s.backlog[route[0]].unshift(v); // emergency vehicle enters ahead of waiting traffic
      s.active++;
    }
  }

  // ---------- helpers ----------

  occupancy(linkId: string) {
    const ls = this.state.links[linkId];
    let n = 0;
    for (const lane of ls.q.L) n += lane.length;
    for (const lane of ls.q.TR) n += lane.length;
    return n / storageOf(this.net.links[linkId]);
  }

  /** Lane on `linkId` with room for a new vehicle in `group`, or -1. */
  private laneWithRoom(linkId: string, group: Group): { lane: number; room: number } {
    const ls = this.state.links[linkId];
    const lanes = ls.q[group];
    const open = group === 'TR' ? lanes.length - ls.closedTR : lanes.length;
    let best = -1;
    let bestRoom = -1;
    for (let i = 0; i < open; i++) {
      const last = lanes[i][lanes[i].length - 1];
      const room = last ? last.x - last.len - JAM_GAP : Infinity;
      if (room >= 0 && room > bestRoom) {
        best = i;
        bestRoom = room;
      }
    }
    return { lane: best, room: bestRoom };
  }

  private canEnterNext(v: Vehicle) {
    const nxt = v.route[v.ri + 1];
    if (!nxt) return true;
    return this.laneWithRoom(nxt, vehicleGroup(this.net, v, v.ri + 1)).lane >= 0;
  }

  /** Delay = time in system − free-flow time for the distance covered (each link at its own speed limit). */
  delayOf(v: Vehicle, t: number) {
    return Math.max(0, t - v.spawnT - v.ffT);
  }

  busLateness(v: Vehicle, t: number) {
    return v.lateness0 + (t - v.spawnT) - v.ffT * SCHEDULE_SLACK;
  }

  // ---------- step ----------

  tickSignals(dt: number) {
    for (const id of this.net.signals) tickSignal(this.state.signals[id], dt);
  }

  moveVehicles(dt: number) {
    const s = this.state;
    const net = this.net;
    const t = s.t;
    const transfers: { v: Vehicle; overflow: number }[] = [];

    for (const link of Object.values(net.links)) {
      const ls = s.links[link.id];
      const exit = isExit(net, link.id);
      const sig = exit ? null : s.signals[link.to];
      for (const group of ['L', 'TR'] as Group[]) {
        const phase = phaseOf(link.heading, group);
        const lanes = ls.q[group];
        for (let li = 0; li < lanes.length; li++) {
          const lane = lanes[li];
          for (let i = 0; i < lane.length; i++) {
            const v = lane[i];
            if (v.movedStep === s.step) continue;
            let limit: number;
            let go = false;
            if (i > 0) limit = lane[i - 1].x - lane[i - 1].len - JAM_GAP;
            else if (exit) {
              limit = Infinity;
              go = true;
            } else {
              // Incidents/roadwork also slow discharge past the blockage (capacity drop).
              const hw = SIM_CONSTANTS.satHeadway / Math.max(0.4, ls.speedFactor);
              go = permits(sig!, phase) && t - ls.lastDis[group][li] >= hw && this.canEnterNext(v);
              limit = go ? link.length + 25 : link.length;
            }
            const vmax = link.vf * ls.speedFactor * (v.kind === 'ems' ? 1.25 : 1);
            let nv = Math.min(vmax, v.v + ACCEL * dt, Math.max(0, limit - v.x) / TIME_GAP);
            if (nv < 0) nv = 0;
            const step = Math.min(nv * dt, Math.max(0, limit - v.x));
            v.x += step;
            v.dist += step;
            v.ffT += step / (link.vf * (v.kind === 'ems' ? 1.25 : 1));
            v.v = nv;
            this.trackStop(v, dt, link.to);
            if (i === 0 && go && v.x >= link.length) transfers.push({ v, overflow: v.x - link.length });
          }
        }
      }
    }

    for (const { v, overflow } of transfers) {
      const cur = net.links[v.route[v.ri]];
      const curGroup = vehicleGroup(net, v);
      const ls = s.links[cur.id];
      ls.q[curGroup][v.lane].shift();
      ls.lastDis[curGroup][v.lane] = t;
      if (v.kind !== 'ems' && t >= SIM_CONSTANTS.warmup && t <= s.measureEnd) s.served[cur.id] = (s.served[cur.id] ?? 0) + 1;
      if (v.ri === v.route.length - 1) {
        this.complete(v);
        continue;
      }
      v.ri++;
      const g = vehicleGroup(net, v);
      const { lane, room } = this.laneWithRoom(v.route[v.ri], g);
      // Room was checked before moving; it can only have shrunk by another transfer this step.
      const target = lane >= 0 ? lane : 0;
      v.lane = target;
      v.x = Math.max(0, Math.min(overflow, room === Infinity ? overflow : room));
      v.movedStep = s.step;
      s.links[v.route[v.ri]].q[g][target].push(v);
    }

    // Release vehicles waiting at the network edge.
    for (const entry of net.entries) {
      const bl = s.backlog[entry];
      // Only vehicles that already failed to enter (spillback to the edge) count as stopped.
      for (const v of bl) if (t - v.spawnT >= dt) this.trackStop(v, dt, null, true);
      while (bl.length) {
        const v = bl[0];
        const g = vehicleGroup(net, v);
        const { lane, room } = this.laneWithRoom(entry, g);
        if (lane < 0) break;
        bl.shift();
        v.lane = lane;
        v.x = 0;
        v.v = Math.min(net.links[entry].vf, room === Infinity ? 99 : room / TIME_GAP);
        v.movedStep = s.step;
        s.links[entry].q[g][lane].push(v);
      }
    }

    // End closures.
    for (const c of s.closures.filter((c) => t >= c.until)) {
      const ls = s.links[c.link];
      ls.closedTR = Math.max(0, ls.closedTR - 1);
      if (!s.closures.some((o) => o !== c && o.link === c.link && t < o.until)) ls.speedFactor = 1;
    }
    s.closures = s.closures.filter((c) => t < c.until);
  }

  private trackStop(v: Vehicle, dt: number, node: string | null, forced = false) {
    const s = this.state;
    const isStopped = forced || v.v < SIM_CONSTANTS.idleSpeed;
    if (isStopped) {
      if (!v.stopped) {
        v.stopped = true;
        v.stops++;
      }
      v.stopRun += dt;
      v.idle += dt;
      if (v.counted) {
        s.metrics.idleSec += dt;
        if (v.stopRun > s.metrics.maxWait) {
          s.metrics.maxWait = v.stopRun;
          s.metrics.maxWaitWhere = node ? this.net.nodes[node].name ?? node : 'network entry (spillback)';
        }
      }
      if (v.kind === 'ems' && node && this.net.nodes[node].kind === 'signal') {
        const r = s.ems[v.id];
        r.nodeDelay[node] = (r.nodeDelay[node] ?? 0) + dt;
      }
    } else if (v.v > SIM_CONSTANTS.idleSpeed * 2) {
      v.stopped = false;
      v.stopRun = 0;
    }
    if (v.stopRun > v.maxStop) v.maxStop = v.stopRun;
  }

  private complete(v: Vehicle) {
    const s = this.state;
    const m = s.metrics;
    const t = s.t;
    s.active--;
    if (v.kind === 'ems') {
      const r = s.ems[v.id];
      r.endT = t;
      r.stops = v.stops;
      r.stoppedTime = v.idle;
      return;
    }
    const d = this.delayOf(v, t);
    m.delayAllCompleted += d;
    if (t >= SIM_CONSTANTS.warmup && t <= s.measureEnd) m.throughput++;
    if (!v.counted) return;
    m.completed++;
    m.delaySum += d;
    m.stopsSum += v.stops;
    if (v.kind === 'bus') {
      m.busCompleted++;
      m.busDelaySum += d;
      m.busPaxDelaySum += d * v.pax;
    }
  }

  advanceClock(dt: number) {
    const s = this.state;
    s.t += dt;
    s.step++;
    if (Math.round(s.t * 2) % 20 === 0) {
      let queued = 0;
      for (const v of this.allVehicles()) if (v.stopped) queued++;
      const m = s.metrics;
      m.series.push({
        t: s.t,
        inNet: s.active,
        queued,
        avgDelay: m.completed ? m.delaySum / m.completed : 0,
        throughput: m.throughput,
        idle: m.idleSec,
      });
    }
  }

  *allVehicles(): Generator<Vehicle> {
    for (const ls of Object.values(this.state.links)) {
      for (const lane of ls.q.L) yield* lane;
      for (const lane of ls.q.TR) yield* lane;
    }
    for (const bl of Object.values(this.state.backlog)) yield* bl;
  }

  /** Current delay of all non-emergency vehicles: completed + still in the network. */
  totalDelayAll() {
    let d = this.state.metrics.delayAllCompleted;
    for (const v of this.allVehicles()) if (v.kind !== 'ems') d += this.delayOf(v, this.state.t);
    return d;
  }

  // ---------- snapshot (the typed contract controllers consume) ----------

  snapshot(): NetworkSnapshot {
    const net = this.net;
    const s = this.state;
    const t = s.t;
    const signals: Record<string, SignalSnap> = {};
    for (const id of net.signals) {
      const sig = s.signals[id];
      const groups: GroupSnap[] = [];
      for (const lid of net.inLinks[id]) {
        const link = net.links[lid];
        const ls = s.links[lid];
        for (const group of ['L', 'TR'] as Group[]) {
          const gs: GroupSnap = {
            link: lid,
            group,
            phase: phaseOf(link.heading, group),
            approach: link.heading,
            count: 0,
            stopped: 0,
            detect: 0,
            approaching: 0,
            maxWait: 0,
            busPax: 0,
            busLate: 0,
            storagePerLane: Math.max(1, Math.floor(link.length / 7)),
            lanes: link.lanes[group],
            downOcc: 0,
            blocked: false,
          };
          let occSum = 0;
          for (const lane of ls.q[group]) {
            lane.forEach((v, i) => {
              if (v.kind === 'ems') return; // EMS handled via priority requests, not counts
              gs.count++;
              if (v.stopped) {
                gs.stopped++;
                gs.maxWait = Math.max(gs.maxWait, v.stopRun);
              } else if (v.x >= link.length - SIM_CONSTANTS.approachZone) gs.approaching++;
              if (v.x >= link.length - SIM_CONSTANTS.detectZone) gs.detect++;
              if (v.kind === 'bus') {
                gs.busPax += v.pax;
                gs.busLate = Math.max(gs.busLate, this.busLateness(v, t));
              }
              occSum += this.occupancy(v.route[v.ri + 1]);
              if (i === 0 && v.x >= link.length - 1 && !this.canEnterNext(v)) gs.blocked = true;
            });
          }
          if (gs.count) gs.downOcc = occSum / gs.count;
          else {
            const outs = group === 'L' ? [net.out[id][LEFT_OF[link.heading]]] : [net.out[id][link.heading], net.out[id][RIGHT_OF[link.heading]]];
            const vals = outs.filter(Boolean).map((o) => this.occupancy(o!));
            gs.downOcc = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
          }
          groups.push(gs);
        }
      }
      signals[id] = { id, name: net.nodes[id].name ?? id, phase: sig.phase, stage: sig.stage, greenT: sig.greenT, groups };
    }

    const ems: EmsSnap[] = [];
    const emsVehicles = [...this.allVehicles()].filter((v) => v.kind === 'ems');
    for (const v of emsVehicles) {
      const inBacklog = s.backlog[v.route[0]].includes(v);
      const ahead: EmsSnap['ahead'] = [];
      let dist = inBacklog ? net.links[v.route[0]].length : net.links[v.route[v.ri]].length - v.x;
      for (let k = v.ri; k < v.route.length; k++) {
        const link = net.links[v.route[k]];
        if (k > v.ri) dist += link.length + 2 * net.boxHalf;
        if (net.nodes[link.to].kind !== 'signal') continue;
        ahead.push({ node: link.to, phase: phaseOf(link.heading, vehicleGroup(net, v, k)), distance: dist });
      }
      ems.push({ id: v.id, route: v.route, ri: v.ri, x: v.x, ahead });
    }
    return { t, signals, ems };
  }
}
