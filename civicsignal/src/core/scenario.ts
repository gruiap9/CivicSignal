// City-independent scenario types and constants. Each city lives in core/cities/.

import type { Network, SimEvent, Turn, Weights } from './types';

export type Side = 'N' | 'S' | 'E' | 'W';
export type Period = 'AM' | 'MIDDAY' | 'PM';

export interface DemandProfile {
  /** veh/h entering on each boundary entry link. */
  entries: Record<string, number>;
  /** Buses/h entering on each boundary entry link (in addition to `entries`). */
  busEntries?: Record<string, number>;
  /** Turning shares per approach link (link id → share of L/T/R). Missing approaches use the defaults. */
  turns?: Record<string, Partial<Record<Turn, number>>>;
  busTurns?: Record<string, Partial<Record<Turn, number>>>;
  turnL: number;
  turnR: number;
}

export interface BusLine {
  id: string;
  name: string;
  nodes: string[];
  headway: number;
  offset: number;
}

export interface EmsRoute {
  id: string;
  name: string;
  nodes: string[];
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  clockHour: number;
  demand: DemandProfile;
  duration: number; // seconds of demand
  events: SimEvent[];
}

export interface SourceNote {
  what: string;
  status: string;
  note: string;
}

export interface CityMeta {
  city: string;
  corridor: string;
  sources: SourceNote[];
  limitations: string[];
}

export interface CityScenario {
  id: string;
  name: string;
  /** Whether demand comes from real counts ('measured') or is invented ('synthetic'). */
  kind: 'measured' | 'synthetic';
  net: Network;
  meta: CityMeta;
  presets: Preset[];
  /** Typical demand per time-of-day period; the baseline's plans are tuned to these. */
  periods: Record<Period, DemandProfile>;
  periodLabels: Record<Period, string>;
  busLines: BusLine[];
  emsRoutes: EmsRoute[];
  defaultPreset: string;
  /** Measured hourly approach volumes per period (approach link id → veh/h), for calibration. */
  observed?: Record<Period, Record<string, number>>;
}

export function todPeriod(clockHour: number): Period {
  if (clockHour >= 6.5 && clockHour < 10) return 'AM';
  if (clockHour >= 15.5 && clockHour < 19) return 'PM';
  return 'MIDDAY';
}

export function nodesToRoute(nodes: string[]): string[] {
  const r: string[] = [];
  for (let i = 0; i < nodes.length - 1; i++) r.push(`${nodes[i]}>${nodes[i + 1]}`);
  return r;
}

export const DEFAULT_WEIGHTS: Weights = { flow: 0.55, climate: 0.15, transit: 0.1, fairness: 0.2 };

export const SIM_CONSTANTS = {
  dt: 0.5,
  warmup: 180,
  cooldown: 300,
  satHeadway: 2.0, // s per lane → 1800 veh/h/lane
  idleSpeed: 2.0, // m/s (≈4.5 mph): below this a vehicle counts as stopped/idle
  yellow: 3.5,
  allRed: 1.5,
  yellowGo: 2.0, // vehicles already at the stop line may still clear in the first 2 s of yellow
  detectZone: 30,
  approachZone: 60,
  skipCap: 90, // supervisor: a phase with a vehicle waiting ≥ this cannot be skipped
};

export const COMMON_LIMITATIONS = [
  'Pedestrians, bikes, parking and transit stops/dwell times are not modeled.',
  'No right-turn-on-red; left turns move only on protected phases, and every approach is given a left-turn lane.',
  'Vehicles do not pull over for emergency vehicles; any emergency benefit comes from signal priority alone.',
  'Incidents and roadwork close one lane to newly arriving vehicles, slow the link and cut its discharge rate (incident: 40% of normal, roadwork: 70%); full closures with rerouting are not modeled.',
  'Routes are fixed when each vehicle is generated (no route choice in response to congestion).',
];
