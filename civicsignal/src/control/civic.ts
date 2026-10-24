// CivicSignal adaptive network controller.
//
// Core: weighted max-pressure (Varaiya 2013). Pressure of a lane group =
// vehicles waiting upstream − (downstream occupancy × group storage), so a phase
// that would push vehicles into a congested link scores low, and a group whose
// downstream link is ≥90% full is blocked entirely (spillback prevention).
// Policy terms are added on top with user weights (normalised to sum to 1):
//   flow     = Σ positive pressure of unblocked groups / 10
//   climate  = Σ stopped vehicles served / 10, plus a cost for stopping a moving platoon
//   transit  = Σ bus passengers × (1 + lateness/2 min) / 40
//   fairness = (longest wait in phase / 45 s)²
// The supervisor still enforces min/max green, clearance, cyclic order with a
// skip limit — this controller only proposes.

import { SIM_CONSTANTS } from '../core/scenario';
import type { SupervisorConfig } from '../core/supervisor';
import { PHASE_NAMES, PHASES, type GroupSnap, type Network, type NetworkSnapshot, type PhaseId, type PhaseRequest, type SignalSnap, type Weights } from '../core/types';
import { PriorityTracker, SAFE_MIN_GREEN, type Controller, type Decision } from './controller';

const BLOCK_OCC = 0.9;
const SWITCH_COST = 0.1;

export interface PhaseScore {
  phase: PhaseId;
  total: number;
  flow: number;
  climate: number;
  transit: number;
  fairness: number;
  hold: number;
  queued: number;
  stopped: number;
  maxWait: number;
  busPax: number;
  busLate: number;
  downOcc: number;
  blocked: number;
}

export function normalizeWeights(w: Weights): Weights {
  const s = w.flow + w.climate + w.transit + w.fairness;
  if (s <= 0) return { flow: 0.25, climate: 0.25, transit: 0.25, fairness: 0.25 };
  return { flow: w.flow / s, climate: w.climate / s, transit: w.transit / s, fairness: w.fairness / s };
}

export function scorePhases(s: SignalSnap, w: Weights): PhaseScore[] {
  return PHASES.map((p) => {
    const gs = s.groups.filter((g) => g.phase === p);
    let pressure = 0;
    let stopped = 0;
    let queued = 0;
    let maxWait = 0;
    let busPax = 0;
    let busLate = 0;
    let occ = 0;
    let blocked = 0;
    let transitRaw = 0;
    for (const g of gs) {
      queued += g.count;
      maxWait = Math.max(maxWait, g.maxWait);
      occ = Math.max(occ, g.downOcc);
      if (g.blocked || g.downOcc >= BLOCK_OCC) {
        if (g.count) blocked += g.count;
        continue;
      }
      pressure += Math.max(0, g.count - g.downOcc * capacity(g));
      stopped += g.stopped;
      busPax += g.busPax;
      busLate = Math.max(busLate, g.busLate);
      transitRaw += g.busPax * (1 + Math.max(0, g.busLate) / 120);
    }
    const flow = pressure / 10;
    const climate = stopped / 10;
    const transit = transitRaw / 40;
    const fairness = (maxWait / 45) ** 2;
    let hold = 0;
    if (p === s.phase && s.stage === 'green' && queued > blocked) {
      const moving = gs.reduce((a, g) => a + g.approaching, 0);
      hold = SWITCH_COST + (w.climate * moving) / 5;
    }
    const total = w.flow * flow + w.climate * climate + w.transit * transit + w.fairness * fairness + hold;
    return { phase: p, total, flow, climate, transit, fairness, hold, queued, stopped, maxWait, busPax, busLate, downOcc: occ, blocked };
  });
}

const capacity = (g: GroupSnap) => g.storagePerLane * g.lanes;

export function explain(best: PhaseScore, cur: PhaseScore | undefined, w: Weights): string {
  const parts: string[] = [];
  const terms = [
    { k: 'flow', v: w.flow * best.flow },
    { k: 'climate', v: w.climate * best.climate },
    { k: 'transit', v: w.transit * best.transit },
    { k: 'fairness', v: w.fairness * best.fairness },
  ].sort((a, b) => b.v - a.v);
  parts.push(`${best.queued} vehicles on ${PHASE_NAMES[best.phase]} (${best.stopped} stopped), downstream ${(best.downOcc * 100).toFixed(0)}% full`);
  if (best.maxWait >= 20) parts.push(`longest wait ${best.maxWait.toFixed(0)}s`);
  if (best.busPax > 0) parts.push(`bus with ${best.busPax} passengers${best.busLate > 30 ? `, ${(best.busLate / 60).toFixed(1)} min late` : ''}`);
  let s = `Chose ${PHASE_NAMES[best.phase]} — ${parts.join('; ')}. Strongest factor: ${terms[0].k}.`;
  if (cur && cur.phase !== best.phase) {
    s += ` Ended ${PHASE_NAMES[cur.phase]} (${cur.queued} vehicles${cur.blocked ? `, ${cur.blocked} blocked by a full downstream link` : ''}; score ${cur.total.toFixed(2)} vs ${best.total.toFixed(2)}).`;
  }
  return s;
}

export class CivicController implements Controller {
  readonly name = 'CivicSignal (adaptive)';
  readonly supervisor: SupervisorConfig = { minGreen: { ...SAFE_MIN_GREEN }, maxGreen: 50, preemptMinGreen: 4 };
  readonly net: Network;
  weights: Weights;
  lastScores: Record<string, PhaseScore[]> = {};
  private prio = new PriorityTracker();

  constructor(net: Network, weights: Weights) {
    this.net = net;
    this.weights = normalizeWeights(weights);
  }

  setWeights(w: Weights) {
    this.weights = normalizeWeights(w);
  }

  clone() {
    const c = new CivicController(this.net, this.weights);
    c.prio.active = { ...this.prio.active };
    return c;
  }

  decide(snap: NetworkSnapshot): Decision {
    const requests: Record<string, PhaseRequest> = {};
    const wanted: Record<string, number> = {};

    // Route-aware emergency priority: request the next signal on the route as soon as the
    // vehicle is on its approach path, and the one after that early so its queue clears.
    for (const e of snap.ems) {
      e.ahead.slice(0, 2).forEach((a, k) => {
        const reach = k === 0 ? 220 : 160;
        if (a.distance > reach || wanted[a.node] !== undefined) return;
        wanted[a.node] = e.id;
        requests[a.node] = {
          ranked: [a.phase],
          preempt: true,
          reason:
            k === 0
              ? `Route-aware priority: emergency vehicle #${e.id} ${a.distance.toFixed(0)} m away needs ${PHASE_NAMES[a.phase]}`
              : `Advance priority: clearing the queue on ${PHASE_NAMES[a.phase]} before emergency vehicle #${e.id} arrives (${a.distance.toFixed(0)} m)`,
        };
      });
    }
    const notes = this.prio.update(snap.t, wanted, (n) => snap.signals[n].name);

    for (const id of this.net.signals) {
      const s = snap.signals[id];
      const scores = scorePhases(s, this.weights);
      this.lastScores[id] = scores;
      if (requests[id]) continue;
      const ranked = [...scores].sort((a, b) => b.total - a.total);
      const best = ranked[0];
      const cur = scores[s.phase];
      // Nothing to serve anywhere → hold.
      if (best.total <= cur.total + 1e-9 || scores.every((x) => x.queued === 0)) {
        requests[id] = { ranked: [s.phase, ...ranked.filter((r) => r.phase !== s.phase).map((r) => r.phase)], reason: 'hold', scores: scores.map((x) => x.total) };
        continue;
      }
      requests[id] = { ranked: ranked.map((r) => r.phase), reason: explain(best, cur, this.weights), scores: scores.map((x) => x.total) };
    }
    return { requests, notes };
  }
}

export const STARVATION_NOTE = `Even with fairness weight 0, the supervisor never lets a waiting vehicle be skipped past ${SIM_CONSTANTS.skipCap}s.`;
