// Shared typed contract between the traffic source, the simulator, the
// controllers and the UI. Everything here is plain data (cloneable).

export type Heading = 'N' | 'E' | 'S' | 'W';
export type Turn = 'L' | 'T' | 'R';
/** Lane group on an approach: exclusive left lane(s) or through+right lanes. */
export type Group = 'L' | 'TR';
/** 0 NS protected left, 1 NS through+right, 2 EW protected left, 3 EW through+right. */
export type PhaseId = 0 | 1 | 2 | 3;
export const PHASES: readonly PhaseId[] = [0, 1, 2, 3];
export const PHASE_NAMES: Record<PhaseId, string> = {
  0: 'N–S left',
  1: 'N–S through',
  2: 'E–W left',
  3: 'E–W through',
};

export type VehicleKind = 'car' | 'bus' | 'ems';

// ---------- Network (static) ----------

export interface NetNode {
  id: string;
  kind: 'signal' | 'boundary';
  x: number; // metres, +x east
  y: number; // metres, +y south
  name?: string;
}

export interface NetLink {
  id: string;
  from: string;
  to: string;
  heading: Heading;
  /** Drivable length from upstream box edge to stop line (m). */
  length: number;
  lanes: Record<Group, number>;
  /** Free-flow speed (m/s). */
  vf: number;
  name: string;
  /** Segment endpoints for drawing. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Network {
  nodes: Record<string, NetNode>;
  links: Record<string, NetLink>;
  signals: string[];
  /** out[nodeId][heading] = linkId leaving that node in that heading. */
  out: Record<string, Partial<Record<Heading, string>>>;
  /** in[nodeId] = links ending at that node. */
  inLinks: Record<string, string[]>;
  entries: string[];
  boxHalf: number;
  /** Degrees the street grid is rotated clockwise from true north (0 for an ideal grid). */
  tilt: number;
}

// ---------- Dynamic sim state ----------

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  route: string[];
  ri: number; // index of current link in route
  x: number; // position along current link (front bumper), m
  v: number;
  lane: number;
  len: number;
  spawnT: number;
  dist: number;
  /** Free-flow time for the distance covered so far (s). */
  ffT: number;
  idle: number;
  stopRun: number; // current continuous stopped duration
  maxStop: number;
  stops: number;
  stopped: boolean;
  counted: boolean; // spawned after warm-up → included in metrics
  movedStep: number;
  pax: number; // bus passengers
  lateness0: number; // bus initial schedule deviation (s)
  label?: string;
  emsNodeDelay?: Record<string, number>;
}

export interface LinkState {
  /** q[group][lane] = vehicles, front (closest to stop line) first. */
  q: Record<Group, Vehicle[][]>;
  lastDis: Record<Group, number[]>;
  closedTR: number; // TR lanes closed to new vehicles (incident/roadwork)
  speedFactor: number;
}

export type Stage = 'green' | 'yellow' | 'allred';

export interface SignalState {
  phase: PhaseId;
  stage: Stage;
  stageT: number;
  greenT: number;
  next: PhaseId;
  preempt: { vehicleId: number; phase: PhaseId } | null;
}

// ---------- Snapshot (what controllers see) ----------

export interface GroupSnap {
  link: string;
  group: Group;
  phase: PhaseId;
  approach: Heading;
  count: number;
  stopped: number;
  /** Vehicles within the 30 m detection zone upstream of the stop line. */
  detect: number;
  /** Moving vehicles within 60 m of the stop line (platoon arriving). */
  approaching: number;
  maxWait: number;
  busPax: number;
  busLate: number;
  storagePerLane: number;
  lanes: number;
  /** Average occupancy fraction of the links this group feeds into. */
  downOcc: number;
  /** Front vehicle cannot enter its next link (spillback). */
  blocked: boolean;
}

export interface SignalSnap {
  id: string;
  name: string;
  phase: PhaseId;
  stage: Stage;
  greenT: number;
  groups: GroupSnap[];
}

export interface EmsSnap {
  id: number;
  route: string[];
  ri: number;
  x: number;
  /** Signal nodes still ahead, in order, with the phase the EMS needs at each. */
  ahead: { node: string; phase: PhaseId; distance: number }[];
}

export interface NetworkSnapshot {
  t: number;
  signals: Record<string, SignalSnap>;
  ems: EmsSnap[];
}

/** A controller's request for one intersection. The supervisor enforces safety. */
export interface PhaseRequest {
  /** Phases in order of preference; ranked[0] is the desired phase. */
  ranked: PhaseId[];
  reason: string;
  preempt?: boolean;
  /** Optional per-phase scores for the UI. */
  scores?: number[];
}

export interface DecisionEntry {
  t: number;
  node: string;
  kind: 'switch' | 'deny' | 'override' | 'preempt' | 'release';
  text: string;
}

// ---------- Events ----------

export type SimEvent =
  | { kind: 'incident'; t: number; link: string; duration: number; label: string }
  | { kind: 'roadwork'; t: number; link: string; duration: number; label: string }
  | { kind: 'surge'; t: number; entries: string[]; factor: number; duration: number; label: string }
  | { kind: 'ems'; t: number; route: string; vehicle: 'ambulance' | 'fire'; label: string };

export interface Weights {
  flow: number;
  climate: number;
  transit: number;
  fairness: number;
}
