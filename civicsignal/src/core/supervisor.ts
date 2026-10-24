// Signal safety supervisor. Controllers only *request* phases; this module is
// the single place where signal states change, and it enforces:
//  - one phase green at a time (phases are pre-defined non-conflicting sets)
//  - minimum green, maximum green
//  - yellow change interval followed by an all-red clearance before any new green
//  - cyclic phase order 0→1→2→3 with skipping; a phase whose vehicles have waited
//    ≥ skipCap may not be skipped (starvation guard, independent of controller weights)

import { SIM_CONSTANTS } from './scenario';
import { PHASE_NAMES, type DecisionEntry, type PhaseId, type PhaseRequest, type SignalSnap, type SignalState } from './types';

export interface SupervisorConfig {
  minGreen: Record<PhaseId, number>;
  maxGreen: number;
  /** Min green that may be truncated to during emergency preemption (yellow/all-red are never cut). */
  preemptMinGreen: number;
}

export function initSignal(phase: PhaseId = 1): SignalState {
  return { phase, stage: 'green', stageT: 0, greenT: 0, next: phase, preempt: null };
}

export type Light = 'G' | 'Y' | 'R';

export function lightFor(sig: SignalState, phase: PhaseId): Light {
  if (sig.phase !== phase || sig.stage === 'allred') return 'R';
  return sig.stage === 'green' ? 'G' : 'Y';
}

/** Can a vehicle at the stop line on `phase` enter the intersection now? */
export function permits(sig: SignalState, phase: PhaseId): boolean {
  if (sig.phase !== phase) return false;
  if (sig.stage === 'green') return true;
  return sig.stage === 'yellow' && sig.stageT < SIM_CONSTANTS.yellowGo;
}

export function tickSignal(sig: SignalState, dt: number) {
  sig.stageT += dt;
  if (sig.stage === 'green') sig.greenT += dt;
  else if (sig.stage === 'yellow' && sig.stageT >= SIM_CONSTANTS.yellow - 1e-9) {
    sig.stage = 'allred';
    sig.stageT = 0;
  } else if (sig.stage === 'allred' && sig.stageT >= SIM_CONSTANTS.allRed - 1e-9) {
    sig.phase = sig.next;
    sig.stage = 'green';
    sig.stageT = 0;
    sig.greenT = 0;
  }
}

function startChange(sig: SignalState, to: PhaseId) {
  sig.stage = 'yellow';
  sig.stageT = 0;
  sig.next = to;
}

const cyc = (p: number) => (p % 4) as PhaseId;

export function applyRequest(
  sig: SignalState,
  req: PhaseRequest,
  snap: SignalSnap,
  cfg: SupervisorConfig,
  t: number,
): DecisionEntry | null {
  const node = snap.id;
  const want = req.ranked[0];
  const entry = (kind: DecisionEntry['kind'], text: string): DecisionEntry => ({ t, node, kind, text });

  if (sig.stage !== 'green') {
    // Already clearing. Preemption may retarget the upcoming green, never shorten clearance.
    if (req.preempt && sig.next !== want) {
      sig.next = want;
      return entry('preempt', `${snap.name}: ${req.reason} → next green retargeted to ${PHASE_NAMES[want]} (clearance kept)`);
    }
    return null;
  }

  if (req.preempt) {
    if (want === sig.phase) return null; // holding a compatible green; max green suspended
    if (sig.greenT < cfg.preemptMinGreen) return null;
    startChange(sig, want);
    return entry('preempt', `${snap.name}: ${req.reason} → ending ${PHASE_NAMES[sig.phase]} via yellow + all-red`);
  }

  const hasDemand = (p: PhaseId) => snap.groups.some((g) => g.phase === p && g.count > 0);
  let target = want;
  let note = '';
  if (target === sig.phase) {
    if (sig.greenT < cfg.maxGreen) return null;
    const alt = req.ranked.find((p) => p !== sig.phase && hasDemand(p));
    if (alt === undefined) return null; // nobody else waiting: rest in current green
    target = alt;
    note = ` (max green ${cfg.maxGreen}s reached)`;
  }

  if (sig.greenT < cfg.minGreen[sig.phase]) {
    return entry('deny', `${snap.name}: request for ${PHASE_NAMES[target]} held — ${PHASE_NAMES[sig.phase]} min green ${cfg.minGreen[sig.phase]}s not yet met`);
  }

  // Starvation guard: phases skipped on the way to `target` must not have long waits.
  for (let k = 1; k < 4; k++) {
    const p = cyc(sig.phase + k);
    if (p === target) break;
    const w = Math.max(0, ...snap.groups.filter((g) => g.phase === p).map((g) => g.maxWait));
    if (w >= SIM_CONSTANTS.skipCap) {
      startChange(sig, p);
      return entry('override', `${snap.name}: supervisor served ${PHASE_NAMES[p]} instead of ${PHASE_NAMES[target]} — a vehicle has waited ${w.toFixed(0)}s (skip limit ${SIM_CONSTANTS.skipCap}s)`);
    }
  }

  startChange(sig, target);
  return entry('switch', `${snap.name}: ${req.reason}${note}`);
}
