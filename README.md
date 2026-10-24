# CivicSignal

A traffic-network simulator and controller evaluation tool. It runs two copies of the same road network side by side with **identical** vehicle arrivals, routes, turns, incidents and emergency events. One copy uses a conventional U.S.-style coordinated-actuated signal plan, the other the **CivicSignal** adaptive network controller. It then reports measured differences honestly, including where CivicSignal does worse.

> INRIX estimated that the typical U.S. driver lost 49 hours to congestion in 2025 ([INRIX 2025 Global Traffic Scorecard](https://inrix.com/blog/traffic-is-back-insights-from-the-2025-inrix-global-traffic-scorecard/)). That figure covers all roads and causes, not just traffic lights. CivicSignal results come from a small simulated grid and are **not** extrapolated to national or real-city savings.

## Run it

Requires Node 20+.

```bash
cd civicsignal
npm install
npm run dev          # http://localhost:5173
npm test             # determinism, safety-invariant and policy-weight tests
npm run calibrate    # prints a headless 3-seed report for every preset
npm run build        # production build in civicsignal/dist
```

## What's in the app

- **Twin network views:** the baseline and CivicSignal side by side, a 3×3 grid modeled on downtown Portland, OR (SW Broadway / 6th / 5th × Alder / Morrison / Yamhill). Shows vehicles, buses, queues and signal states; click an intersection to inspect it.
- **Controls:** play/pause/reset, speed, seed, and six scenario presets (balanced, PM peak-direction, turning-heavy, incident, emergency, demo story).
- **Policy weights:** Flow, Climate, Transit and Fairness, kept summing to 1. They change CivicSignal's phase scoring live, with plain-language explanations of its decisions.
- **Disruptions:** a seeded random incident, a traffic surge by direction, and roadwork on a chosen link for a chosen duration.
- **Emergency vehicle:** a simulated ambulance or fire truck on a selectable route.
  - Baseline: local preemption at ≤150 m (can be toggled off).
  - CivicSignal: route-aware priority, handed forward along the route, with early queue clearing.
  - Measures trip time, delay, stops per intersection, and extra delay imposed on other traffic (against a counterfactual copy without the emergency vehicle).
- **Metrics:** average delay (all vehicles, including those still in the network, and completed trips), throughput, idle vehicle-seconds (< 2 m/s), max wait, stops, bus delay, and idle CO₂ (labeled as a rough estimate).
  - Live charts.
  - Every result is labeled *live run*, *single-run result* or *average across N seeds*.
- **Matched multi-seed evaluation** runs in a Web Worker and reports means, ranges, paired % change and "better in k/N seeds", plus a **tradeoff sweep** of any one weight.
- **Reproducibility:** reset with "replay my events" re-runs the same seed with the same user-triggered events and weight changes. **Export/Import** saves the seed, demand preset, weights, events and results as JSON.
- **Data & assumptions** table: what is sourced, modeled or generated, plus limitations.

## Architecture

```
src/core/scenario.ts   city scenario, demand presets, constants, data-source notes
src/core/demand.ts     seeded traffic source (TrafficSource interface; replaceable by SUMO / camera counts)
src/core/sim.ts        lane-based simulator → NetworkSnapshot (typed contract in core/types.ts)
src/core/supervisor.ts safety supervisor: the only code that changes signal states
src/control/baseline.ts  Webster-timed, coordinated-actuated baseline (+ local EV preemption)
src/control/civic.ts     CivicSignal: weighted max-pressure + policy terms + route-aware EV priority
src/core/twin.ts       runs both copies in lockstep from one demand stream + one event schedule
src/core/metrics.ts, batch.ts   metrics, comparisons, matched multi-seed evaluation
src/ui/*               React UI (canvas network views, SVG charts, panels, batch worker)
```

Controllers only *request* phases. The supervisor enforces:
- one non-conflicting phase at a time
- min and max green
- yellow (3.5 s) plus all-red (1.5 s) before every new green
- cyclic phase order with skipping
- a starvation guard: a phase whose vehicle has waited ≥ 90 s cannot be skipped

Emergency preemption may shorten a green to 4 s but never cuts clearance.

## Honesty notes

- **The baseline is not a straw man.** It uses Webster splits on the expected demand, a common cycle, green-wave offsets, gap-out actuation, phase skipping and early return to the coordinated phase. The "retime baseline" toggle gives it a plan tuned to the exact scenario demand.
- **CivicSignal does not win everywhere.** In the bundled presets (3 seeds each) it measured roughly 30% lower average delay and idle time, but:
  - it made ~10% more stops per trip;
  - at default weights its max wait was often *higher* than the baseline's;
  - its emergency priority can impose more delay on other traffic than the baseline's local preemption.
- **These are simulation results** from a simplified model with modeled demand and timing. They are not real Portland signal plans or counts, and not real-world performance.
- **What isn't modeled:** pedestrians, right-turn-on-red, permissive lefts, rerouting, rail, and vehicles yielding to emergency vehicles.
