import { describe, expect, test } from 'vitest';
import { scorePhases } from '../control/civic';
import { KENDALL } from './cities/kendall';
import { calibration, summarizeTwin } from './metrics';
import { DEFAULT_WEIGHTS, SIM_CONSTANTS } from './scenario';
import { Twin } from './twin';
import type { SignalSnap, SignalState } from './types';

const cfg = (presetId: string, seed = 7, cityId = 'portland') => ({ cityId, presetId, seed, weights: DEFAULT_WEIGHTS, retimeBaseline: false, baselinePreemption: true });

describe('Kendall network (OSM + Cambridge counts)', () => {
  test('one-way streets are respected: no link against OSM one-way direction', () => {
    const net = KENDALL.net;
    // Charles St is one-way eastbound between Third and First; Thorndike only enters First St.
    expect(net.links['H3>H1']).toBeDefined();
    expect(net.links['H1>H3']).toBeUndefined();
    expect(net.out['T1'].W).toBeUndefined();
  });

  test('reproducible with measured demand', () => {
    const a = new Twin(cfg('story', 5, 'kendall'));
    const b = new Twin(cfg('story', 5, 'kendall'));
    a.runToEnd();
    b.runToEnd();
    expect(summarizeTwin(a)).toEqual(summarizeTwin(b));
  });

  test('PM peak reproduces measured approach volumes (GEH < 5 on ≥85% of approaches)', () => {
    const tw = new Twin(cfg('pm', 1, 'kendall'));
    tw.runToEnd();
    const cal = calibration(tw)!;
    expect(cal.length).toBeGreaterThan(15);
    expect(cal.filter((c) => c.geh < 5).length / cal.length).toBeGreaterThanOrEqual(0.85);
  });
});

describe('reproducibility', () => {
  test('same seed and events → identical results', () => {
    const a = new Twin(cfg('story'));
    const b = new Twin(cfg('story'));
    a.runToEnd();
    b.runToEnd();
    expect(summarizeTwin(a)).toEqual(summarizeTwin(b));
  });

  test('replaying recorded user events reproduces the run', () => {
    const a = new Twin(cfg('balanced'));
    for (let i = 0; i < 600; i++) a.step();
    a.randomIncident();
    a.emergency('ems-we', 'ambulance');
    a.runToEnd();
    const b = new Twin({ ...cfg('balanced'), extraEvents: a.userEvents });
    b.runToEnd();
    expect(summarizeTwin(b)).toEqual(summarizeTwin(a));
  });

  test('both controllers receive identical demand', () => {
    const tw = new Twin(cfg('peak'));
    tw.runToEnd();
    expect(tw.baseline.sim.state.metrics.spawned).toBe(tw.civic.sim.state.metrics.spawned);
    expect(tw.baseline.sim.state.metrics.spawned).toBeGreaterThan(1000);
  });
});

describe('safety supervisor invariants', () => {
  test.each([
    ['portland', 'balanced'],
    ['portland', 'story'],
    ['portland', 'turning'],
    ['kendall', 'pm'],
    ['kendall', 'story'],
  ])('%s/%s: clearance always precedes a new green; min green respected', (city, preset) => {
    const tw = new Twin(cfg(preset, 3, city));
    const prev: Record<string, Record<string, SignalState>> = {};
    while (!tw.done) {
      tw.step();
      for (const run of [tw.baseline, tw.civic]) {
        const key = run.controller.name;
        const p = (prev[key] ??= {});
        for (const [id, s] of Object.entries(run.sim.state.signals)) {
          const before = p[id];
          if (before) {
            // A phase change can only happen out of all-red, after full yellow + all-red.
            if (before.phase !== s.phase) {
              expect(before.stage).toBe('allred');
              expect(s.stage).toBe('green');
            }
            // Green → anything other than green must go through yellow.
            if (before.stage === 'green' && s.stage !== 'green') expect(s.stage).toBe('yellow');
            if (before.stage === 'yellow' && s.stage === 'allred') expect(before.stageT + tw.dt).toBeGreaterThanOrEqual(SIM_CONSTANTS.yellow - 1e-6);
            // Green may only end after min green (preemption may shorten to preemptMinGreen).
            if (before.stage === 'green' && s.stage === 'yellow') {
              expect(before.greenT + tw.dt).toBeGreaterThanOrEqual(run.controller.supervisor.preemptMinGreen - 1e-6);
            }
          }
          p[id] = { ...s };
        }
      }
    }
  });

  test.each([
    ['portland', 'story'],
    ['kendall', 'story'],
  ])('%s/%s: vehicles are conserved (spawned = completed + in network)', (city, preset) => {
    const tw = new Twin(cfg(preset, 11, city));
    for (let i = 0; i < 2400; i++) tw.step();
    for (const run of [tw.baseline, tw.civic]) {
      const st = run.sim.state;
      let inNet = 0;
      for (const v of run.sim.allVehicles()) if (v.counted && v.kind !== 'ems') inNet++;
      expect(st.metrics.completed + inNet).toBe(st.metrics.spawned);
    }
  });
});

describe('CivicSignal policy weights', () => {
  const snap: SignalSnap = {
    id: 'X',
    name: 'X',
    phase: 1,
    stage: 'green',
    greenT: 20,
    groups: [
      // N–S through: many vehicles, short waits
      { link: 'a', group: 'TR', phase: 1, approach: 'S', count: 12, stopped: 2, detect: 4, approaching: 6, maxWait: 5, busPax: 0, busLate: 0, storagePerLane: 8, lanes: 2, downOcc: 0.2, blocked: false },
      // E–W left: one vehicle that has waited long
      { link: 'b', group: 'L', phase: 2, approach: 'E', count: 1, stopped: 1, detect: 1, approaching: 0, maxWait: 80, busPax: 0, busLate: 0, storagePerLane: 8, lanes: 1, downOcc: 0.1, blocked: false },
      // E–W through: a late, full bus
      { link: 'c', group: 'TR', phase: 3, approach: 'E', count: 2, stopped: 2, detect: 2, approaching: 0, maxWait: 30, busPax: 55, busLate: 240, storagePerLane: 8, lanes: 2, downOcc: 0.1, blocked: false },
    ],
  };
  const best = (w: Parameters<typeof scorePhases>[1]) => [...scorePhases(snap, w)].sort((a, b) => b.total - a.total)[0].phase;

  test('flow weight keeps the busy through movement', () => expect(best({ flow: 1, climate: 0, transit: 0, fairness: 0 })).toBe(1));
  test('fairness weight serves the long-waiting left', () => expect(best({ flow: 0.2, climate: 0, transit: 0, fairness: 0.8 })).toBe(2));
  test('transit weight serves the late bus', () => expect(best({ flow: 0.2, climate: 0, transit: 0.8, fairness: 0 })).toBe(3));

  test('a downstream-blocked movement gets no flow credit (spillback prevention)', () => {
    const blocked = { ...snap, groups: snap.groups.map((g) => (g.phase === 1 ? { ...g, downOcc: 0.95 } : g)) };
    const s = scorePhases(blocked, { flow: 1, climate: 0, transit: 0, fairness: 0 });
    expect(s[1].flow).toBe(0);
    expect(s[1].blocked).toBe(12);
  });
});
