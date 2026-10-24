import { buildGrid } from './network';
import type { Network, SimEvent, Weights } from './types';

// ---------- City scenario: downtown Portland, Oregon (simplified) ----------

export const CITY = {
  city: 'Portland, Oregon (USA)',
  corridor: 'Downtown grid around Pioneer Courthouse Square — SW Broadway / 6th / 5th × SW Alder / Morrison / Yamhill',
  sources: [
    {
      what: 'Block geometry',
      status: 'Sourced (approximate)',
      note: 'Portland’s downtown uses 200 ft (≈61 m) blocks with ≈60 ft streets, giving ≈80 m between intersection centres. Street names and order follow OpenStreetMap; coordinates were not imported.',
    },
    {
      what: 'Lane configuration & directions',
      status: 'Modeled (simplified)',
      note: 'Every street is modelled as two-way with one left-turn lane and two through/right lanes per approach. In reality many of these streets are one-way, and SW 5th/6th are a transit mall.',
    },
    {
      what: 'Traffic demand',
      status: 'Generated',
      note: 'Poisson arrivals from seeded random numbers using assumed hourly volumes per entry. No measured counts were used.',
    },
    {
      what: 'Turning shares',
      status: 'Assumed',
      note: 'Fixed left/right shares per preset (e.g. 15% / 15%).',
    },
    {
      what: 'Signal timing (baseline)',
      status: 'Modeled',
      note: 'Computed with Webster’s method from the modeled demand, plus green-wave offsets. These are NOT the City of Portland’s actual signal plans.',
    },
    {
      what: 'Buses',
      status: 'Generated',
      note: 'Two modeled bus lines with seeded passenger loads and schedule deviation. Not TriMet schedules. No stops or dwell times are modeled.',
    },
  ],
  limitations: [
    'MAX light rail on Morrison/Yamhill, pedestrians, bikes and parking are not modeled.',
    'No right-turn-on-red; left turns move only on protected phases.',
    'Vehicles do not pull over for emergency vehicles; any emergency benefit comes from signal priority alone.',
    'Incidents and roadwork close one lane to newly arriving vehicles, slow the link and cut its discharge rate (incident: 40% of normal, roadwork: 70%); full closures with rerouting are not modeled.',
    'Routes are fixed when each vehicle is generated (no route choice in response to congestion).',
    'Results describe this simplified model only, not real Portland traffic.',
  ],
};

export const AVENUES = ['SW Broadway', 'SW 6th Ave', 'SW 5th Ave'];
export const STREETS = ['SW Alder St', 'SW Morrison St', 'SW Yamhill St'];

export function buildPortland(): Network {
  return buildGrid({
    avenues: AVENUES,
    streets: STREETS,
    spacing: 80,
    approach: 160,
    vf: 11.2, // 25 mph
    lanes: { L: 1, TR: 2 },
  });
}

// ---------- Demand ----------

export type Side = 'N' | 'S' | 'E' | 'W';

export interface DemandProfile {
  /** veh/h entering from each side, per avenue/street index. N = enters from the north edge (southbound). */
  rates: Record<Side, number[]>;
  turnL: number;
  turnR: number;
}

export function entryLinkId(side: Side, i: number) {
  const b = side === 'N' ? `BN${i}` : side === 'S' ? `BS${i}` : side === 'W' ? `BW${i}` : `BE${i}`;
  const s = side === 'N' ? `I0${i}` : side === 'S' ? `I2${i}` : side === 'W' ? `I${i}0` : `I${i}2`;
  return `${b}>${s}`;
}

const flat = (v: number) => [v, v, v];

export const TOD_PROFILES: Record<'AM' | 'MIDDAY' | 'PM', DemandProfile> = {
  AM: { rates: { N: [520, 560, 520], S: flat(260), W: [480, 520, 480], E: flat(260) }, turnL: 0.15, turnR: 0.15 },
  MIDDAY: { rates: { N: flat(380), S: flat(380), W: flat(360), E: flat(360) }, turnL: 0.15, turnR: 0.15 },
  PM: { rates: { N: flat(260), S: [540, 600, 540], W: flat(280), E: [500, 540, 500] }, turnL: 0.15, turnR: 0.15 },
};

export function todPeriod(clockHour: number): 'AM' | 'MIDDAY' | 'PM' {
  if (clockHour >= 6.5 && clockHour < 9.5) return 'AM';
  if (clockHour >= 15.5 && clockHour < 19) return 'PM';
  return 'MIDDAY';
}

// Fixed bus lines (node sequences) — modeled, not real TriMet routes.
export const BUS_LINES = [
  { id: 'bus-ns', name: 'Modeled Line A (southbound on SW 6th)', nodes: ['BN1', 'I01', 'I11', 'I21', 'BS1'], headway: 240, offset: 30 },
  { id: 'bus-we', name: 'Modeled Line B (eastbound on SW Morrison)', nodes: ['BW1', 'I10', 'I11', 'I12', 'BE1'], headway: 300, offset: 90 },
];

export const EMS_ROUTES = [
  { id: 'ems-ns', name: 'Southbound SW 6th Ave (straight)', nodes: ['BN1', 'I01', 'I11', 'I21', 'BS1'] },
  { id: 'ems-we', name: 'Eastbound SW Morrison St (straight)', nodes: ['BW1', 'I10', 'I11', 'I12', 'BE1'] },
  { id: 'ems-turn', name: 'Alder EB → right on 6th → left on Yamhill (2 turns)', nodes: ['BW0', 'I00', 'I01', 'I11', 'I21', 'I22', 'BE2'] },
];

export function nodesToRoute(nodes: string[]): string[] {
  const r: string[] = [];
  for (let i = 0; i < nodes.length - 1; i++) r.push(`${nodes[i]}>${nodes[i + 1]}`);
  return r;
}

// ---------- Presets ----------

export interface Preset {
  id: string;
  name: string;
  description: string;
  clockHour: number;
  demand: DemandProfile;
  duration: number; // seconds of demand
  events: SimEvent[];
}

const DURATION = 1800;

export const PRESETS: Preset[] = [
  {
    id: 'balanced',
    name: 'Balanced demand (midday)',
    description: 'Similar volumes on every approach. The baseline plan was tuned for exactly this demand, so it is the hardest case for an adaptive controller to beat.',
    clockHour: 12,
    demand: TOD_PROFILES.MIDDAY,
    duration: DURATION,
    events: [],
  },
  {
    id: 'peak',
    name: 'Peak-direction demand (PM)',
    description: 'Heavy northbound and westbound flows at 17:30. The baseline uses its PM time-of-day plan.',
    clockHour: 17.5,
    demand: TOD_PROFILES.PM,
    duration: DURATION,
    events: [],
  },
  {
    id: 'turning',
    name: 'Turning-heavy demand',
    description: '30% left and 20% right turns at midday. The baseline still runs its midday plan, which assumed 15%/15%. Use “retime baseline” to give it a plan tuned to these turns.',
    clockHour: 12,
    demand: { ...TOD_PROFILES.MIDDAY, turnL: 0.3, turnR: 0.2 },
    duration: DURATION,
    events: [],
  },
  {
    id: 'incident',
    name: 'Incident on SW 6th',
    description: 'Midday demand. At 5:00 an incident closes one southbound lane of SW 6th Ave between Alder and Morrison for 10 minutes.',
    clockHour: 12,
    demand: TOD_PROFILES.MIDDAY,
    duration: DURATION,
    events: [{ kind: 'incident', t: 300, link: 'I01>I11', duration: 600, label: 'Scheduled incident: SW 6th SB, Alder→Morrison' }],
  },
  {
    id: 'emergency',
    name: 'Emergency response',
    description: 'Midday demand. At 7:00 a simulated ambulance enters southbound on SW 6th Ave.',
    clockHour: 12,
    demand: TOD_PROFILES.MIDDAY,
    duration: DURATION,
    events: [{ kind: 'ems', t: 420, route: 'ems-ns', vehicle: 'ambulance', label: 'Scheduled ambulance: SW 6th SB' }],
  },
  {
    id: 'story',
    name: 'Demo story: PM surge + incident + ambulance',
    description: 'PM peak. A surge from the south (4:00), an incident on SW Morrison eastbound (6:00), and a fire truck on a turning route (9:00).',
    clockHour: 17.5,
    demand: TOD_PROFILES.PM,
    duration: DURATION,
    events: [
      { kind: 'surge', t: 240, entries: [entryLinkId('S', 0), entryLinkId('S', 1), entryLinkId('S', 2)], factor: 1.4, duration: 480, label: 'Surge: +40% from the south' },
      { kind: 'incident', t: 360, link: 'I10>I11', duration: 480, label: 'Incident: SW Morrison EB, Broadway→6th' },
      { kind: 'ems', t: 540, route: 'ems-turn', vehicle: 'fire', label: 'Fire truck: Alder → 6th → Yamhill' },
    ],
  },
];

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
