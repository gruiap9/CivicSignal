// Conventional U.S.-style baseline: time-of-day coordinated timing plan
// (common cycle, Webster splits, green-wave offsets on the N–S avenues) with
// actuated non-coordinated phases (gap-out, skip when no call, early return to
// the coordinated phase) and optional local emergency preemption. Timing rules
// are fixed for the whole run.

import { SeededDemand } from '../core/demand';
import { groupOf, turnBetween } from '../core/network';
import type { DemandProfile } from '../core/scenario';
import { SIM_CONSTANTS } from '../core/scenario';
import type { SupervisorConfig } from '../core/supervisor';
import { PHASE_NAMES, PHASES, type Network, type NetworkSnapshot, type PhaseId, type PhaseRequest } from '../core/types';
import { PriorityTracker, SAFE_MIN_GREEN, type Controller, type Decision } from './controller';

const CLEAR = SIM_CONSTANTS.yellow + SIM_CONSTANTS.allRed;
const SEQ: PhaseId[] = [1, 2, 3, 0]; // cycle order starting at the coordinated phase
const LOST_PER_PHASE = 5; // s (clearance + start-up − yellow used)
const SAT = 1800;

export interface TimingPlan {
  label: string;
  cycle: number;
  coordPhase: PhaseId;
  progression: 'southbound' | 'northbound';
  splits: Record<string, Record<PhaseId, number>>;
  offsets: Record<string, number>;
  criticalY: Record<string, number>;
}

/** Webster's method on expected movement volumes, with a common cycle for coordination. */
export function computePlan(net: Network, demand: DemandProfile, label: string): TimingPlan {
  const flows = SeededDemand.expectedMovementFlows(net, demand);
  const ys: Record<string, Record<PhaseId, number>> = {};
  let cycle = 60;
  const criticalY: Record<string, number> = {};
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
    }
    ys[id] = y;
    const Y = PHASES.reduce<number>((a, p) => a + y[p], 0);
    criticalY[id] = Y;
    const L = 4 * LOST_PER_PHASE;
    const c0 = Y < 0.9 ? (1.5 * L + 5) / (1 - Y) : 120;
    cycle = Math.max(cycle, c0);
  }
  cycle = Math.min(120, Math.ceil(cycle / 5) * 5);

  const splits: TimingPlan['splits'] = {};
  for (const id of net.signals) {
    const y = ys[id];
    const G = cycle - 4 * CLEAR;
    const Y = PHASES.reduce<number>((a, p) => a + y[p], 0) || 1;
    const g: Record<PhaseId, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const p of PHASES) g[p] = Math.max(SAFE_MIN_GREEN[p], (G * y[p]) / Y);
    // Rescale phases above their minimum so the greens sum to G.
    const excess = PHASES.reduce<number>((a, p) => a + g[p], 0) - G;
    const flex = PHASES.filter((p) => g[p] > SAFE_MIN_GREEN[p]);
    const flexSum = flex.reduce<number>((a, p) => a + g[p] - SAFE_MIN_GREEN[p], 0);
    for (const p of flex) g[p] -= (excess * (g[p] - SAFE_MIN_GREEN[p])) / flexSum;
    for (const p of PHASES) g[p] = Math.round(g[p] * 2) / 2;
    splits[id] = g;
  }

  const south = demand.rates.N.reduce((a, b) => a + b, 0) >= demand.rates.S.reduce((a, b) => a + b, 0);
  const offsets: Record<string, number> = {};
  for (const id of net.signals) {
    const r = Number(id[1]);
    const k = south ? r : 2 - r;
    const vf = Object.values(net.links)[0].vf;
    offsets[id] = Math.round(((k * 80) / vf) % cycle);
  }
  return { label, cycle, coordPhase: 1, progression: south ? 'southbound' : 'northbound', splits, offsets, criticalY };
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

  /** Force-off time (end of green) of each phase within the cycle. */
  forceOffs(id: string) {
    const g = this.plan.splits[id];
    const fo: Record<PhaseId, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    let t = 0;
    for (const p of SEQ) {
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
      const fo = this.forceOffs(id);
      const tc = (((snap.t - this.plan.offsets[id]) % C) + C) % C;
      const call = (p: PhaseId) => s.groups.some((g) => g.phase === p && g.count > 0);
      const detect = (p: PhaseId) => s.groups.some((g) => g.phase === p && g.detect > 0);
      const hold = (reason: string): PhaseRequest => ({ ranked: [s.phase], reason });
      const nextAfter = (from: PhaseId): PhaseId => {
        const i = SEQ.indexOf(from);
        for (let k = i + 1; k < SEQ.length; k++) {
          const p = SEQ[k];
          // Serve a called phase if any of its window remains; min green may run slightly past
          // its force-off, and the following phases absorb that (coordination is restored at tc=0).
          if (call(p) && tc + CLEAR < fo[p]) return p;
        }
        return 1;
      };

      if (s.stage !== 'green') {
        requests[id] = hold('clearing');
        continue;
      }
      if (s.phase === 1) {
        if (tc < fo[1]) {
          requests[id] = hold('coordinated green until yield point');
          continue;
        }
        const n = nextAfter(1);
        requests[id] =
          n === 1
            ? hold('resting in coordinated phase (no side-street calls)')
            : { ranked: [n, 1], reason: `yield point reached at cycle ${tc.toFixed(0)}s; serving call on ${PHASE_NAMES[n]}` };
        continue;
      }
      const forced = tc >= fo[s.phase] || tc < fo[1];
      const gapOut = !detect(s.phase);
      if (forced || gapOut) {
        const n = nextAfter(s.phase);
        requests[id] = { ranked: [n, 1], reason: `${forced ? 'force-off' : 'gap-out (detector empty)'} on ${PHASE_NAMES[s.phase]} → ${PHASE_NAMES[n]}` };
      } else requests[id] = hold('extending green: vehicles in detection zone');
    }
    return { requests, notes };
  }
}
