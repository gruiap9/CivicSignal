import type { Sim } from './sim';
import { SIM_CONSTANTS } from './scenario';
import type { Twin } from './twin';

// Rough idle-CO₂ proxy, NOT an emissions model: U.S. DOE says light-duty idling
// burns ≈0.25–0.5 gal/h (we use 0.375); EPA: 8,887 g CO₂ per gallon of gasoline.
export const IDLE_GAL_PER_H = 0.375;
export const CO2_KG_PER_GAL = 8.887;

export interface EmsSummary {
  label: string;
  done: boolean;
  trip: number;
  freeFlow: number;
  delay: number;
  stops: number;
  nodeDelay: Record<string, number>;
}

export interface Summary {
  t: number;
  spawned: number;
  completed: number;
  inNetwork: number;
  avgDelayCompleted: number;
  /** Average delay over ALL counted vehicles, including those still in the network (avoids survivorship bias). */
  avgDelayAll: number;
  throughput: number;
  idleVehSec: number;
  idlePerVeh: number;
  maxWait: number;
  maxWaitWhere: string;
  stopsPerVeh: number;
  co2Kg: number;
  busAvgDelay: number;
  busPaxDelayH: number;
  ems: EmsSummary[];
  /** Extra delay (veh·s) that emergency vehicles imposed on other traffic vs. a no-EMS copy. */
  emsImpact: number | null;
}

export function summarize(sim: Sim, shadow?: Sim): Summary {
  const s = sim.state;
  const m = s.metrics;
  let inNet = 0;
  let pendingDelay = 0;
  let pendingCount = 0;
  for (const v of sim.allVehicles()) {
    if (v.kind === 'ems') continue;
    inNet++;
    if (v.counted) {
      pendingCount++;
      pendingDelay += sim.delayOf(v, s.t);
    }
  }
  const counted = m.completed + pendingCount;
  const ems = Object.values(s.ems).map((r) => {
    const trip = (r.endT ?? s.t) - r.spawnT;
    return {
      label: r.label,
      done: r.endT !== null,
      trip,
      freeFlow: r.freeFlow,
      delay: Math.max(0, trip - r.freeFlow),
      stops: r.stops,
      nodeDelay: r.nodeDelay,
    };
  });
  return {
    t: s.t,
    spawned: m.spawned,
    completed: m.completed,
    inNetwork: inNet,
    avgDelayCompleted: m.completed ? m.delaySum / m.completed : 0,
    avgDelayAll: counted ? (m.delaySum + pendingDelay) / counted : 0,
    throughput: m.throughput,
    idleVehSec: m.idleSec,
    idlePerVeh: counted ? m.idleSec / counted : 0,
    maxWait: m.maxWait,
    maxWaitWhere: m.maxWaitWhere,
    stopsPerVeh: m.completed ? m.stopsSum / m.completed : 0,
    co2Kg: (m.idleSec / 3600) * IDLE_GAL_PER_H * CO2_KG_PER_GAL,
    busAvgDelay: m.busCompleted ? m.busDelaySum / m.busCompleted : 0,
    busPaxDelayH: m.busPaxDelaySum / 3600,
    ems,
    emsImpact: shadow ? sim.totalDelayAll() - shadow.totalDelayAll() : null,
  };
}

export function summarizeTwin(tw: Twin) {
  return {
    baseline: summarize(tw.baseline.sim, tw.shadows?.baseline.sim),
    civic: summarize(tw.civic.sim, tw.shadows?.civic.sim),
  };
}

export type MetricKey = 'avgDelayAll' | 'avgDelayCompleted' | 'throughput' | 'idleVehSec' | 'maxWait' | 'stopsPerVeh' | 'co2Kg' | 'busAvgDelay';

export const METRICS: { key: MetricKey; label: string; unit: string; better: 'lower' | 'higher'; note?: string; digits: number }[] = [
  { key: 'avgDelayAll', label: 'Avg delay (all vehicles)', unit: 's/veh', better: 'lower', digits: 1, note: 'Includes vehicles still in the network at the time shown.' },
  { key: 'avgDelayCompleted', label: 'Avg delay (completed trips)', unit: 's/veh', better: 'lower', digits: 1 },
  { key: 'throughput', label: 'Throughput (trips done in demand window)', unit: 'trips', better: 'higher', digits: 0 },
  { key: 'idleVehSec', label: 'Idle vehicle-time (< 2 m/s)', unit: 'veh·s', better: 'lower', digits: 0 },
  { key: 'maxWait', label: 'Max single wait', unit: 's', better: 'lower', digits: 0 },
  { key: 'stopsPerVeh', label: 'Stops per trip', unit: '', better: 'lower', digits: 2 },
  { key: 'co2Kg', label: 'Idle CO₂ (rough estimate)', unit: 'kg', better: 'lower', digits: 1, note: 'Estimate: idle time × 0.375 gal/h (DOE range) × 8.887 kg/gal (EPA). Not an emissions model.' },
  { key: 'busAvgDelay', label: 'Bus avg delay', unit: 's/bus', better: 'lower', digits: 1 },
];

/** "average delay was 12% lower" style sentence; positive `pct` means CivicSignal is better. */
export function compare(base: number, civ: number, better: 'lower' | 'higher') {
  if (base === 0 && civ === 0) return { pct: 0, text: 'no difference' };
  const raw = base === 0 ? (civ > 0 ? 100 : -100) : ((civ - base) / Math.abs(base)) * 100;
  const improved = better === 'lower' ? raw < 0 : raw > 0;
  const mag = Math.abs(raw);
  if (mag < 0.5) return { pct: 0, text: 'about the same' };
  return {
    pct: improved ? mag : -mag,
    text: `${mag.toFixed(mag < 10 ? 1 : 0)}% ${raw < 0 ? 'lower' : 'higher'} (${improved ? 'better' : 'worse'})`,
  };
}

export interface CalibrationRow {
  link: string;
  label: string;
  observed: number;
  simulated: number;
  geh: number;
}

/**
 * Simulated vs. measured hourly approach volumes at sensored intersections (baseline copy).
 * GEH = sqrt(2(M−C)²/(M+C)); the usual acceptance target is GEH < 5 for ≥85% of counts.
 * Only meaningful for presets that replay the measured demand without surges.
 */
export function calibration(tw: Twin): CalibrationRow[] | null {
  const obs = tw.city.observed?.[tw.period];
  if (!obs) return null;
  const s = tw.baseline.sim.state;
  const hours = (Math.min(s.t, s.measureEnd) - SIM_CONSTANTS.warmup) / 3600;
  if (hours <= 0.05) return [];
  return Object.entries(obs)
    .filter(([, m]) => m >= 20)
    .map(([link, m]) => {
      const c = (s.served[link] ?? 0) / hours;
      const l = tw.net.links[link];
      return {
        link,
        label: `${tw.net.nodes[l.to].name}: ${l.name.replace(/ ([NESW])B$/, ' $1B approach')}`,
        observed: m,
        simulated: c,
        geh: Math.sqrt((2 * (m - c) ** 2) / (m + c || 1)),
      };
    })
    .sort((a, b) => b.geh - a.geh);
}
