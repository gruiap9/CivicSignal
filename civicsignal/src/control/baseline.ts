// Conventional U.S.-style baseline: time-of-day coordinated timing plan
// (common cycle, Webster splits, green-wave offsets along the busier axis) with
// actuated non-coordinated phases (gap-out, skip when no call, early return to
// the coordinated phase) and optional local emergency preemption. Timing rules
// are fixed for the whole run.

import { SeededDemand } from '../core/demand';
import { groupOf, headingVector, turnBetween } from '../core/network';
import type { BusLine, DemandProfile } from '../core/scenario';
import { SIM_CONSTANTS } from '../core/scenario';
import type { SupervisorConfig } from '../core/supervisor';
import { PHASE_NAMES, PHASES, type Heading, type Network, type NetworkSnapshot, type PhaseId, type PhaseRequest } from '../core/types';
import { PriorityTracker, SAFE_MIN_GREEN, type Controller, type Decision } from './controller';

const CLEAR = SIM_CONSTANTS.yellow + SIM_CONSTANTS.allRed;
const LOST_PER_PHASE = 5; // s (clearance + start-up − yellow used)
const SAT = 1800;

export interface TimingPlan {
  label: string;
  cycle: number;
  /** Coordinated phase at each signal (through phase on the busier axis, if it exists there). */
  coord: Record<string, PhaseId>;
  /** Phases in cycle order at each signal, starting with the coordinated phase; phases with no demand are omitted. */
  seq: Record<string, PhaseId[]>;
  progression: string;
  splits: Record<string, Record<PhaseId, number>>;
  offsets: Record<string, number>;
  criticalY: Record<string, number>;
}

/** Webster's method on expected movement volumes, with a common cycle for coordination. */
export function computePlan(net: Network, demand: DemandProfile, busLines: BusLine[], label: string): TimingPlan {
  const flows = SeededDemand.expectedMovementFlows(net, demand, busLines);
  const ys: Record<string, Record<PhaseId, number>> = {};
  const criticalY: Record<string, number> = {};
  const axisFlow = { NS: 0, EW: 0 };
  const dirFlow: Record<Heading, number> = { N: 0, S: 0, E: 0, W: 0 };
  let cycle = 60;
  for (const id of net.signals) {
    const y: Record<PhaseId, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const lid of net.inLinks[id]) {
      const link = net.links[lid];
      const gFlow = { L: 0, TR: 0 };
      for (const [key, vph] of Object.entries(flows)) {
        const [a, b] = key.split('|');
        if (a !== lid) continue;
        gFlow[groupOf(turnBetween(link.heading, net.links[b].heading))] += vph;
      }
      const ns = link.heading === 'N' || link.heading === 'S';
      y[ns ? 0 : 2] = Math.max(y[ns ? 0 : 2], gFlow.L / (SAT * link.lanes.L));
      y[ns ? 1 : 3] = Math.max(y[ns ? 1 : 3], gFlow.TR / (SAT * link.lanes.TR));
      axisFlow[ns ? 'NS' : 'EW'] += gFlow.TR;
      dirFlow[link.heading] += gFlow.TR;
    }
    ys[id] = y;
    const active = PHASES.filter((p) => y[p] > 0);
    const Y = active.reduce<number>((a, p) => a + y[p], 0);
    criticalY[id] = Y;
    const L = active.length * LOST_PER_PHASE;
    const c0 = Y < 0.9 ? (1.5 * L + 5) / (1 - Y) : 120;
    cycle = Math.max(cycle, c0);
  }
  cycle = Math.min(120, Math.ceil(cycle / 5) * 5);

  const axisPhase: PhaseId = axisFlow.NS >= axisFlow.EW ? 1 : 3;
  const coord: TimingPlan['coord'] = {};
  const seq: TimingPlan['seq'] = {};
  const splits: TimingPlan['splits'] = {};
  for (const id of net.signals) {
    const y = ys[id];
    const active = PHASES.filter((p) => y[p] > 0);
    const c: PhaseId = y[axisPhase] > 0 ? axisPhase : active.find((p) => p === 1 || p === 3) ?? active[0] ?? axisPhase;
    coord[id] = c;
    seq[id] = [0, 1, 2, 3].map((k) => ((c + k) % 4) as PhaseId).filter((p) => p === c || y[p] > 0);
    const G = cycle - seq[id].length * CLEAR;
    const Y = seq[id].reduce<number>((a, p) => a + y[p], 0) || 1;
    const g: Record<PhaseId, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const p of seq[id]) g[p] = Math.max(SAFE_MIN_GREEN[p], (G * y[p]) / Y);
    // Rescale phases above their minimum so the greens sum to G.
    const excess = seq[id].reduce<number>((a, p) => a + g[p], 0) - G;
    const flex = seq[id].filter((p) => g[p] > SAFE_MIN_GREEN[p]);
    const flexSum = flex.reduce<number>((a, p) => a + g[p] - SAFE_MIN_GREEN[p], 0);
    if (flexSum > 0) for (const p of flex) g[p] -= (excess * (g[p] - SAFE_MIN_GREEN[p])) / flexSum;
    for (const p of seq[id]) g[p] = Math.round(g[p] * 2) / 2;
    splits[id] = g;
  }

  // Green wave along the coordinated axis in its heavier direction.
  const dir: Heading = axisPhase === 1 ? (dirFlow.S >= dirFlow.N ? 'S' : 'N') : dirFlow.E >= dirFlow.W ? 'E' : 'W';
  const [ux, uy] = headingVector(dir, net.tilt);
  const proj = (id: string) => net.nodes[id].x * ux + net.nodes[id].y * uy;
  const p0 = Math.min(...net.signals.map(proj));
  const vf = Object.values(net.links).reduce((a, l) => a + l.vf, 0) / Object.keys(net.links).length;
  const offsets: Record<string, number> = {};
  for (const id of net.signals) offsets[id] = Math.round(((proj(id) - p0) / vf) % cycle);
  const names: Record<Heading, string> = { N: 'northbound', S: 'southbound', E: 'eastbound', W: 'westbound' };
  return { label, cycle, coord, seq, progression: names[dir], splits, offsets, criticalY };
}

export class BaselineController implements Controller {
  readonly name = 'Baseline (coordinated-actuated)';
  readonly supervisor: SupervisorConfig = { minGreen: { ...SAFE_MIN_GREEN }, maxGreen: 999, preemptMinGreen: 4 };
  readonly plan: TimingPlan;
  readonly net: Network;
  readonly preemption: boolean;
  private prio = new PriorityTracker();

  constructor(net: Network, plan: TimingPlan, preemption: boolean) {
    this.net = net;
    this.plan = plan;
    this.preemption = preemption;
  }

  clone() {
    const c = new BaselineController(this.net, this.plan, this.preemption);
    c.prio.active = { ...this.prio.active };
    return c;
  }

  /** Force-off time (end of green) of each phase in the cycle; undefined for omitted phases. */
  forceOffs(id: string) {
    const g = this.plan.splits[id];
    const fo: Partial<Record<PhaseId, number>> = {};
    let t = 0;
    for (const p of this.plan.seq[id]) {
      t += g[p];
      fo[p] = t;
      t += CLEAR;
    }
    return fo;
  }

  decide(snap: NetworkSnapshot): Decision {
    const requests: Record<string, PhaseRequest> = {};
    const C = this.plan.cycle;
    const wanted: Record<string, number> = {};

    if (this.preemption) {
      // Local preemption: an optical/GPS detector on each approach fires when an EMS is ≤150 m away.
      for (const e of snap.ems) {
        const first = e.ahead[0];
        if (first && first.distance <= 150 && wanted[first.node] === undefined) {
          wanted[first.node] = e.id;
          requests[first.node] = {
            ranked: [first.phase],
            preempt: true,
            reason: `Local preemption: emergency vehicle #${e.id} detected ${first.distance.toFixed(0)} m away`,
          };
        }
      }
    }
    const notes = this.prio.update(snap.t, wanted, (n) => snap.signals[n].name);

    for (const id of this.net.signals) {
      if (requests[id]) continue;
      const s = snap.signals[id];
      const seq = this.plan.seq[id];
      const coord = this.plan.coord[id];
      const fo = this.forceOffs(id);
      const tc = (((snap.t - this.plan.offsets[id]) % C) + C) % C;
      const call = (p: PhaseId) => s.groups.some((g) => g.phase === p && g.count > 0);
      const detect = (p: PhaseId) => s.groups.some((g) => g.phase === p && g.detect > 0);
      const hold = (reason: string): PhaseRequest => ({ ranked: [s.phase], reason });
      const nextAfter = (from: PhaseId): PhaseId => {
        const i = seq.indexOf(from);
        for (let k = i + 1; k < seq.length; k++) {
          const p = seq[k];
          // Serve a called phase if any of its window remains; min green may run slightly past
          // its force-off, and the following phases absorb that (coordination is restored at tc=0).
          if (call(p) && tc + CLEAR < fo[p]!) return p;
        }
        return coord;
      };

      if (s.stage !== 'green') {
        requests[id] = hold('clearing');
        continue;
      }
      if (s.phase === coord) {
        if (tc < fo[coord]!) {
          requests[id] = hold('coordinated green until yield point');
          continue;
        }
        const n = nextAfter(coord);
        requests[id] =
          n === coord
            ? hold('resting in coordinated phase (no side-street calls)')
            : { ranked: [n, coord], reason: `yield point reached at cycle ${tc.toFixed(0)}s; serving call on ${PHASE_NAMES[n]}` };
        continue;
      }
      const end = fo[s.phase];
      const forced = end === undefined || tc >= end || tc < fo[coord]!;
      const gapOut = !detect(s.phase);
      if (forced || gapOut) {
        const n = seq.includes(s.phase) ? nextAfter(s.phase) : coord;
        requests[id] = { ranked: [n, coord], reason: `${forced ? 'force-off' : 'gap-out (detector empty)'} on ${PHASE_NAMES[s.phase]} → ${PHASE_NAMES[n]}` };
      } else requests[id] = hold('extending green: vehicles in detection zone');
    }
    return { requests, notes };
  }
}
