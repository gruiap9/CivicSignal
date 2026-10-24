import type { SupervisorConfig } from '../core/supervisor';
import type { DecisionEntry, NetworkSnapshot, PhaseRequest } from '../core/types';

export interface Decision {
  requests: Record<string, PhaseRequest>;
  notes: DecisionEntry[];
}

export interface Controller {
  readonly name: string;
  readonly supervisor: SupervisorConfig;
  decide(snap: NetworkSnapshot): Decision;
  clone(): Controller;
}

/** Emergency priority bookkeeping shared by both controllers (plain data, cloneable). */
export class PriorityTracker {
  active: Record<string, number> = {}; // node → EMS vehicle id

  /** Returns release notes for nodes whose EMS has left their request set. */
  update(t: number, wanted: Record<string, number>, names: (n: string) => string): DecisionEntry[] {
    const notes: DecisionEntry[] = [];
    for (const [node, id] of Object.entries(this.active)) {
      if (wanted[node] !== id)
        notes.push({ t, node, kind: 'release', text: `${names(node)}: emergency vehicle #${id} cleared — priority released, normal control resumes` });
    }
    this.active = { ...wanted };
    return notes;
  }
}

export const SAFE_MIN_GREEN = { 0: 5, 1: 8, 2: 5, 3: 8 } as const;
