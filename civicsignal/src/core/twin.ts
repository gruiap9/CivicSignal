// Runs two (or more) copies of the same network in lockstep. One shared
// traffic source and one event schedule feed every copy identical arrivals,
// routes, turning choices, incidents and emergency vehicles.

import { BaselineController, computePlan, type TimingPlan } from '../control/baseline';
import { CivicController } from '../control/civic';
import type { Controller } from '../control/controller';
import { SeededDemand } from './demand';
import { hashSeed, Rng } from './rng';
import { cityById } from './cities';
import { SIM_CONSTANTS, todPeriod, type CityScenario, type Period, type Preset, type Side } from './scenario';
import { Sim } from './sim';
import { applyRequest } from './supervisor';
import type { DecisionEntry, Heading, Network, SimEvent, Weights } from './types';

export class Run {
  sim: Sim;
  controller: Controller;
  log: DecisionEntry[] = [];
  private lastKind: Record<string, string> = {};

  constructor(sim: Sim, controller: Controller) {
    this.sim = sim;
    this.controller = controller;
  }

  clone(): Run {
    const r = new Run(this.sim.clone(), this.controller.clone());
    r.lastKind = { ...this.lastKind };
    return r;
  }

  step(dt: number) {
    const s = this.sim.state;
    if (s.step % Math.round(1 / dt) === 0) {
      const snap = this.sim.snapshot();
      const { requests, notes } = this.controller.decide(snap);
      for (const n of notes) this.push(n);
      for (const [node, req] of Object.entries(requests)) {
        const e = applyRequest(s.signals[node], req, snap.signals[node], this.controller.supervisor, s.t);
        if (e) this.push(e);
      }
    }
    this.sim.tickSignals(dt);
    this.sim.moveVehicles(dt);
    this.sim.advanceClock(dt);
  }

  private push(e: DecisionEntry) {
    // Repeated "held by min green" notices are noise: log only the first in a row per node.
    if (e.kind === 'deny' && this.lastKind[e.node] === 'deny') return;
    this.lastKind[e.node] = e.kind;
    this.log.push(e);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }
}

export interface TwinConfig {
  cityId: string;
  presetId: string;
  seed: number;
  weights: Weights;
  retimeBaseline: boolean;
  baselinePreemption: boolean;
  /** Extra user-triggered events to replay (recorded from a previous live run). */
  extraEvents?: SimEvent[];
  /** Mid-run weight changes to replay. */
  weightChanges?: WeightChange[];
}

export interface WeightChange {
  t: number;
  w: Weights;
}

export interface AppliedEvent {
  ev: SimEvent;
  source: 'preset' | 'user';
}

export class Twin {
  readonly city: CityScenario;
  readonly net: Network;
  readonly cfg: TwinConfig;
  readonly period: Period;
  readonly preset: Preset;
  readonly plan: TimingPlan;
  readonly demand: SeededDemand;
  readonly baseline: Run;
  readonly civic: Run;
  /** Counterfactual copies without emergency vehicles, created at the first EMS trigger. */
  shadows: { baseline: Run; civic: Run } | null = null;
  private schedule: AppliedEvent[] = [];
  applied: AppliedEvent[] = [];
  userEvents: SimEvent[] = [];
  weightChanges: WeightChange[] = [];
  private pendingWeights: WeightChange[];
  private eventRng: Rng;
  private nextEmsId = 900000;
  readonly dt = SIM_CONSTANTS.dt;
  readonly endT: number;

  constructor(cfg: TwinConfig) {
    this.cfg = cfg;
    this.city = cityById(cfg.cityId);
    this.net = this.city.net;
    this.preset = this.city.presets.find((p) => p.id === cfg.presetId) ?? this.city.presets.find((p) => p.id === this.city.defaultPreset)!;
    this.period = todPeriod(this.preset.clockHour);
    this.plan = cfg.retimeBaseline
      ? computePlan(this.net, this.preset.demand, this.city.busLines, `Retimed for this scenario's demand (best-case fixed timing)`)
      : planFor(this.city, this.period);
    this.demand = new SeededDemand(this.net, this.preset.demand, this.city.busLines, cfg.seed, this.preset.duration);
    this.baseline = new Run(new Sim(this.net), new BaselineController(this.net, this.plan, cfg.baselinePreemption));
    this.civic = new Run(new Sim(this.net), new CivicController(this.net, cfg.weights));
    for (const r of [this.baseline, this.civic]) {
      r.sim.state.measureEnd = this.preset.duration;
      // Both copies start in the baseline's coordinated phase so neither gets a head start.
      for (const id of this.net.signals) r.sim.state.signals[id].phase = r.sim.state.signals[id].next = this.plan.coord[id];
    }
    this.eventRng = new Rng(hashSeed(cfg.seed, 'events'));
    for (const ev of this.preset.events) this.schedule.push({ ev, source: 'preset' });
    for (const ev of cfg.extraEvents ?? []) this.schedule.push({ ev, source: 'user' });
    this.schedule.sort((a, b) => a.ev.t - b.ev.t);
    this.endT = this.preset.duration + SIM_CONSTANTS.cooldown;
    this.pendingWeights = [...(cfg.weightChanges ?? [])].sort((a, b) => a.t - b.t);
  }

  get t() {
    return this.civic.sim.state.t;
  }

  get done() {
    return this.t >= this.endT - 1e-9;
  }

  runs(): Run[] {
    return this.shadows ? [this.baseline, this.civic, this.shadows.baseline, this.shadows.civic] : [this.baseline, this.civic];
  }

  /** Change CivicSignal weights now; recorded so a reset can replay it. */
  setWeights(w: Weights) {
    this.weightChanges.push({ t: this.t, w: { ...w } });
    this.applyWeights(w);
  }

  private applyWeights(w: Weights) {
    (this.civic.controller as CivicController).setWeights(w);
    if (this.shadows) (this.shadows.civic.controller as CivicController).setWeights(w);
  }

  step() {
    if (this.done) return;
    const t = this.t;
    while (this.pendingWeights.length && this.pendingWeights[0].t <= t + 1e-9) {
      const wc = this.pendingWeights.shift()!;
      this.weightChanges.push(wc);
      this.applyWeights(wc.w);
    }
    while (this.schedule.length && this.schedule[0].ev.t <= t + 1e-9) {
      const a = this.schedule.shift()!;
      this.apply(a);
    }
    const arrivals = this.demand.step(t, this.dt);
    for (const r of this.runs()) {
      // Each copy gets its own vehicle objects but identical ids, times and routes.
      r.sim.inject(arrivals.map((a) => ({ ...a, route: [...a.route] })));
      r.step(this.dt);
    }
  }

  private apply(a: AppliedEvent) {
    const ev = a.ev;
    this.applied.push(a);
    if (ev.kind === 'surge') {
      this.demand.applySurge(ev.entries, ev.factor, ev.t + ev.duration, this.t);
      return;
    }
    if (ev.kind === 'ems' && !this.shadows) {
      this.shadows = { baseline: this.baseline.clone(), civic: this.civic.clone() };
    }
    const id = ev.kind === 'ems' ? this.nextEmsId++ : 0;
    const route = ev.kind === 'ems' ? this.city.emsRoutes.find((r) => r.id === ev.route) : undefined;
    if (ev.kind === 'ems' && !route) return;
    this.baseline.sim.applyEvent(ev, id, route);
    this.civic.sim.applyEvent(ev, id, route);
    if (ev.kind !== 'ems' && this.shadows) {
      this.shadows.baseline.sim.applyEvent(ev, id);
      this.shadows.civic.sim.applyEvent(ev, id);
    }
  }

  /** Schedule a user event at the current time (applied identically to both copies). */
  trigger(ev: SimEvent) {
    const e = { ...ev, t: Math.ceil(this.t / this.dt) * this.dt } as SimEvent;
    this.userEvents.push(e);
    this.schedule.push({ ev: e, source: 'user' });
    this.schedule.sort((a, b) => a.ev.t - b.ev.t);
  }

  randomIncident(duration = 480) {
    const candidates = Object.values(this.net.links).filter((l) => this.net.nodes[l.to].kind === 'signal');
    const l = this.eventRng.pick(candidates);
    this.trigger({ kind: 'incident', t: 0, link: l.id, duration, label: `Random incident: ${l.name}, approaching ${this.net.nodes[l.to].name}` });
  }

  surge(side: Side, factor = 1.6, duration = 600) {
    const opp: Record<Side, Heading> = { N: 'S', S: 'N', E: 'W', W: 'E' };
    const entries = this.net.entries.filter((e) => this.net.links[e].heading === opp[side]);
    const names: Record<Side, string> = { N: 'north', S: 'south', E: 'east', W: 'west' };
    this.trigger({ kind: 'surge', t: 0, entries, factor, duration, label: `Surge: +${Math.round((factor - 1) * 100)}% from the ${names[side]} for ${duration / 60} min` });
  }

  roadwork(linkId: string, duration: number) {
    const l = this.net.links[linkId];
    this.trigger({ kind: 'roadwork', t: 0, link: linkId, duration, label: `Roadwork: lane closed on ${l.name} for ${Math.round(duration / 60)} min` });
  }

  emergency(routeId: string, vehicle: 'ambulance' | 'fire') {
    const r = this.city.emsRoutes.find((x) => x.id === routeId)!;
    this.trigger({ kind: 'ems', t: 0, route: routeId, vehicle, label: `${vehicle === 'fire' ? 'Fire truck' : 'Ambulance'} (simulated): ${r.name}` });
  }

  runToEnd() {
    while (!this.done) this.step();
  }
}

const planCache: Record<string, TimingPlan> = {};
export function planFor(city: CityScenario, period: Period): TimingPlan {
  const name = period === 'MIDDAY' ? 'Midday' : period;
  const src = city.kind === 'measured' ? 'from measured counts' : 'from modeled demand';
  return (planCache[`${city.id}:${period}`] ??= computePlan(city.net, city.periods[period], city.busLines, `${name} time-of-day plan (${src})`));
}
