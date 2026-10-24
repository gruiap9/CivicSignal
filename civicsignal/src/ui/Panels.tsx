import { useState } from 'react';
import { scorePhases, type CivicController } from '../control/civic';
import type { BaselineController } from '../control/baseline';
import { calibration, compare, METRICS, type Summary } from '../core/metrics';
import { SIM_CONSTANTS, type Side } from '../core/scenario';
import { lightFor } from '../core/supervisor';
import type { Twin } from '../core/twin';
import { PHASE_NAMES, PHASES, type DecisionEntry, type Weights } from '../core/types';
import { fmtClock } from './LineChart';

export const BASE_COLOR = '#d95926';
export const CIVIC_COLOR = '#3987e5';

// ---------------- Policy weights ----------------

const TERMS: { key: keyof Weights; label: string; desc: string }[] = [
  { key: 'flow', label: 'Flow', desc: 'Serve the movements with the most queued vehicles relative to free downstream space (max-pressure). Reduces average delay.' },
  { key: 'climate', label: 'Climate', desc: 'Serve stopped vehicles and avoid stopping moving platoons. Reduces idle vehicle-seconds (CO₂ shown only as a rough estimate).' },
  { key: 'transit', label: 'Transit', desc: 'Favor movements carrying buses, weighted by passengers and schedule lateness.' },
  { key: 'fairness', label: 'Fairness', desc: 'Grows with the square of the longest wait so low-volume approaches are not ignored.' },
];

export function rebalance(w: Weights, key: keyof Weights, val: number): Weights {
  const others = TERMS.map((t) => t.key).filter((k) => k !== key);
  const rest = others.reduce((a, k) => a + w[k], 0);
  const out = { ...w, [key]: val } as Weights;
  for (const k of others) out[k] = rest > 0 ? (w[k] / rest) * (1 - val) : (1 - val) / 3;
  return out;
}

export function PolicyPanel({ weights, onChange, explanations }: { weights: Weights; onChange: (w: Weights) => void; explanations: DecisionEntry[] }) {
  return (
    <section className="panel">
      <h3>Policy weights <span className="muted">(sum = 1.00)</span></h3>
      <p className="hint">Sliders change CivicSignal’s scoring live, which changes which phases it requests. The baseline never changes during a run.</p>
      {TERMS.map((t) => (
        <label key={t.key} className="slider" title={t.desc}>
          <span className="slider-head">
            <b>{t.label}</b>
            <output>{weights[t.key].toFixed(2)}</output>
          </span>
          <input type="range" min={0} max={1} step={0.01} value={weights[t.key]} onChange={(e) => onChange(rebalance(weights, t.key, Number(e.target.value)))} />
          <small>{t.desc}</small>
        </label>
      ))}
      <p className="hint">{`Starvation guard: even with fairness at 0, the safety supervisor never skips a phase whose vehicle has waited ${SIM_CONSTANTS.skipCap}s or more.`}</p>
      {explanations.length > 0 && (
        <div className="explain">
          <b>Latest CivicSignal decisions</b>
          {explanations.map((e, i) => (
            <p key={i}>
              <span className="muted">{fmtClock(e.t)}</span> {e.text}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------- Disruptions & emergency ----------------

export function DisruptionPanel({ twin, onDone }: { twin: Twin; onDone: () => void }) {
  const [side, setSide] = useState<Side>('S');
  const linkOpts = Object.values(twin.net.links).filter((l) => twin.net.nodes[l.to].kind === 'signal');
  const [rwLink, setRwLink] = useState(linkOpts[0].id);
  const [rwMin, setRwMin] = useState(10);
  const act = (f: () => void) => {
    f();
    onDone();
  };
  return (
    <section className="panel">
      <h3>Disruptions</h3>
      <p className="hint">Each event is applied to both copies at the same simulation time. Random choices come from the run seed, so a reset with replay reproduces them. These are controlled test events, not crash predictions.</p>
      <div className="row">
        <button onClick={() => act(() => twin.randomIncident())}>⚠ Random incident (8 min)</button>
      </div>
      <div className="row">
        <select value={side} onChange={(e) => setSide(e.target.value as Side)} aria-label="Surge direction">
          <option value="N">from north</option>
          <option value="S">from south</option>
          <option value="E">from east</option>
          <option value="W">from west</option>
        </select>
        <button onClick={() => act(() => twin.surge(side))}>Traffic surge +60% (10 min)</button>
      </div>
      <div className="row">
        <select value={rwLink} onChange={(e) => setRwLink(e.target.value)} aria-label="Roadwork link">
          {linkOpts.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name.replace('SW ', '')} approaching {twin.net.nodes[l.to].name?.replace(/SW /g, '')}
            </option>
          ))}
        </select>
        <input type="number" min={1} max={30} value={rwMin} onChange={(e) => setRwMin(Number(e.target.value))} aria-label="Roadwork minutes" style={{ width: 52 }} />
        <span className="muted">min</span>
        <button onClick={() => act(() => twin.roadwork(rwLink, rwMin * 60))}>Roadwork</button>
      </div>
    </section>
  );
}

export function EmergencyPanel({ twin, onDone }: { twin: Twin; onDone: () => void }) {
  const routes = twin.city.emsRoutes;
  const [route, setRoute] = useState(routes[0].id);
  const [kind, setKind] = useState<'ambulance' | 'fire'>('ambulance');
  return (
    <section className="panel">
      <h3>Emergency vehicle <span className="badge">simulated</span></h3>
      <p className="hint">
        The vehicle drives its route in both copies. <b>Baseline</b>: local preemption when it is ≤150 m from a signal{twin.cfg.baselinePreemption ? '' : ' (turned OFF for this run)'}. <b>CivicSignal</b>: route-aware priority at the next signal (≤220 m) plus early queue clearing at the one after (≤160 m). Both keep full yellow and all-red. This is not connected to any real dispatch system.
      </p>
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value as 'ambulance' | 'fire')} aria-label="Vehicle type">
          <option value="ambulance">Ambulance</option>
          <option value="fire">Fire truck</option>
        </select>
        <select value={route} onChange={(e) => setRoute(e.target.value)} aria-label="Route">
          {routes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <button className="danger" onClick={() => (twin.emergency(route, kind), onDone())}>
        🚑 Dispatch now
      </button>
    </section>
  );
}

// ---------------- Metrics ----------------

export function MetricsTable({ base, civic, status }: { base: Summary; civic: Summary; status: string }) {
  return (
    <section className="panel wide">
      <h3>
        CivicSignal vs. baseline <span className="badge">{status}</span>
      </h3>
      <table className="metrics">
        <thead>
          <tr>
            <th>Metric</th>
            <th style={{ color: BASE_COLOR }}>Baseline</th>
            <th style={{ color: CIVIC_COLOR }}>CivicSignal</th>
            <th>CivicSignal vs. baseline</th>
          </tr>
        </thead>
        <tbody>
          {METRICS.map((m) => {
            const c = compare(base[m.key], civic[m.key], m.better);
            return (
              <tr key={m.key} title={m.note}>
                <td>
                  {m.label} {m.unit && <span className="muted">{m.unit}</span>}
                  {m.note && <sup className="muted"> ⓘ</sup>}
                </td>
                <td className="num">{base[m.key].toFixed(m.digits)}</td>
                <td className="num">{civic[m.key].toFixed(m.digits)}</td>
                <td className={c.pct > 0 ? 'better' : c.pct < 0 ? 'worse' : ''}>
                  {c.pct > 0 ? '▲ ' : c.pct < 0 ? '▼ ' : ''}
                  {c.text}
                </td>
              </tr>
            );
          })}
          <tr>
            <td>Vehicles generated (after warm-up) / still in network</td>
            <td className="num">
              {base.spawned} / {base.inNetwork}
            </td>
            <td className="num">
              {civic.spawned} / {civic.inNetwork}
            </td>
            <td className="muted">identical demand</td>
          </tr>
        </tbody>
      </table>
      <p className="hint">
        Delay = time in system − distance ÷ free-flow speed. The first {SIM_CONSTANTS.warmup / 60} min are warm-up and excluded. Idle = speed below {SIM_CONSTANTS.idleSpeed} m/s (≈4.5 mph), including vehicles held at the network edge.
        “Max wait” is the longest single stop: {base.maxWaitWhere && `baseline at ${base.maxWaitWhere}`}
        {civic.maxWaitWhere && `; CivicSignal at ${civic.maxWaitWhere}`}.
      </p>
    </section>
  );
}

export function EmsCard({ twin, base, civic }: { twin: Twin; base: Summary; civic: Summary }) {
  if (!base.ems.length) return null;
  const names = (rec: Record<string, number>) =>
    Object.entries(rec)
      .filter(([, s]) => s >= 0.5)
      .map(([n, s]) => `${twin.net.nodes[n].name?.replace(/SW /g, '')}: ${s.toFixed(0)}s`)
      .join(', ') || 'no stops at signals';
  return (
    <section className="panel wide">
      <h3>
        Emergency vehicle results <span className="badge">simulated</span>
      </h3>
      <table className="metrics">
        <thead>
          <tr>
            <th>Vehicle</th>
            <th style={{ color: BASE_COLOR }}>Baseline</th>
            <th style={{ color: CIVIC_COLOR }}>CivicSignal</th>
          </tr>
        </thead>
        <tbody>
          {base.ems.map((b, i) => {
            const c = civic.ems[i];
            if (!c) return null;
            return (
              <tr key={i}>
                <td>
                  {b.label}
                  <div className="muted">free-flow trip {b.freeFlow.toFixed(0)}s</div>
                </td>
                <td>
                  {b.done ? `${b.trip.toFixed(0)}s trip` : `en route ${b.trip.toFixed(0)}s`} · delay {b.delay.toFixed(0)}s · {b.stops} stop{b.stops === 1 ? '' : 's'}
                  <div className="muted">{names(b.nodeDelay)}</div>
                </td>
                <td>
                  {c.done ? `${c.trip.toFixed(0)}s trip` : `en route ${c.trip.toFixed(0)}s`} · delay {c.delay.toFixed(0)}s · {c.stops} stop{c.stops === 1 ? '' : 's'}
                  <div className="muted">{names(c.nodeDelay)}</div>
                </td>
              </tr>
            );
          })}
          <tr>
            <td>
              Extra delay imposed on other traffic
              <div className="muted">vs. an identical copy without emergency vehicles</div>
            </td>
            <td className="num">{base.emsImpact !== null ? `${base.emsImpact.toFixed(0)} veh·s` : '–'}</td>
            <td className="num">{civic.emsImpact !== null ? `${civic.emsImpact.toFixed(0)} veh·s` : '–'}</td>
          </tr>
        </tbody>
      </table>
      <p className="hint">Small or negative impact values are within run-to-run noise: any change in signal timing reshuffles which vehicles get stopped.</p>
    </section>
  );
}

// ---------------- Decision log ----------------

export function DecisionLog({ twin }: { twin: Twin }) {
  const [side, setSide] = useState<'civic' | 'baseline'>('civic');
  const [filter, setFilter] = useState<'all' | 'priority' | 'supervisor'>('all');
  const log = (side === 'civic' ? twin.civic : twin.baseline).log;
  const shown = log
    .filter((e) => (filter === 'all' ? true : filter === 'priority' ? e.kind === 'preempt' || e.kind === 'release' : e.kind === 'deny' || e.kind === 'override'))
    .slice(-80)
    .reverse();
  return (
    <section className="panel">
      <h3>Decision log</h3>
      <div className="row tabs">
        <button className={side === 'civic' ? 'on' : ''} onClick={() => setSide('civic')}>
          CivicSignal
        </button>
        <button className={side === 'baseline' ? 'on' : ''} onClick={() => setSide('baseline')}>
          Baseline
        </button>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Filter">
          <option value="all">all entries</option>
          <option value="priority">emergency priority</option>
          <option value="supervisor">safety supervisor</option>
        </select>
      </div>
      <ol className="log">
        {shown.length === 0 && <li className="muted">No decisions yet. Press Play.</li>}
        {shown.map((e, i) => (
          <li key={i} className={`k-${e.kind}`}>
            <span className="muted">{fmtClock(e.t)}</span> <span className="kind">{e.kind}</span> {e.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------- Intersection inspector ----------------

export function Inspector({ twin, node }: { twin: Twin; node: string }) {
  const sides = [
    { label: 'Baseline', color: BASE_COLOR, run: twin.baseline },
    { label: 'CivicSignal', color: CIVIC_COLOR, run: twin.civic },
  ];
  const civ = twin.civic.controller as CivicController;
  const snapC = twin.civic.sim.snapshot().signals[node];
  const scores = scorePhases(snapC, civ.weights);
  const maxScore = Math.max(0.01, ...scores.map((s) => s.total));
  const plan = (twin.baseline.controller as BaselineController).plan;
  return (
    <section className="panel">
      <h3>{twin.net.nodes[node].name}</h3>
      <div className="inspect">
        {sides.map(({ label, color, run }) => {
          const sig = run.sim.state.signals[node];
          const snap = run.sim.snapshot().signals[node];
          return (
            <div key={label}>
              <b style={{ color }}>{label}</b>
              <div className="muted">
                {PHASE_NAMES[sig.phase]} · {sig.stage} {sig.stage === 'green' ? `${sig.greenT.toFixed(0)}s` : ''}
                {sig.stage !== 'green' && ` → ${PHASE_NAMES[sig.next]}`}
              </div>
              <table className="mini">
                <thead>
                  <tr>
                    <th>Approach</th>
                    <th>Light</th>
                    <th>Queue</th>
                    <th>Max wait</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.groups.map((g) => (
                    <tr key={g.link + g.group}>
                      <td>
                        {g.approach}B {g.group === 'L' ? 'left' : 'thru/right'}
                      </td>
                      <td>
                        <span className={`dot ${lightFor(sig, g.phase)}`} />
                      </td>
                      <td className="num">
                        {g.stopped}/{g.count}
                        {g.blocked ? ' ⛔' : ''}
                      </td>
                      <td className="num">{g.maxWait.toFixed(0)}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
      <b>CivicSignal phase scores now</b>
      <div className="scores">
        {PHASES.map((p) => (
          <div key={p} className="score-row" title={`flow ${scores[p].flow.toFixed(2)} · climate ${scores[p].climate.toFixed(2)} · transit ${scores[p].transit.toFixed(2)} · fairness ${scores[p].fairness.toFixed(2)} · hold bonus ${scores[p].hold.toFixed(2)}`}>
            <span>{PHASE_NAMES[p]}</span>
            <span className="bar">
              <i style={{ width: `${(scores[p].total / maxScore) * 100}%`, background: CIVIC_COLOR }} />
            </span>
            <span className="num">{scores[p].total.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <p className="hint">
        Queue = stopped/total vehicles; ⛔ = front vehicle blocked by a full downstream link. Baseline plan: {plan.label}, cycle {plan.cycle}s, offset {plan.offsets[node]}s, splits{' '}
        {PHASES.map((p) => `${PHASE_NAMES[p]} ${plan.splits[node][p]}s`).join(', ')}.
      </p>
    </section>
  );
}

// ---------------- Scenario / data notes ----------------

export function ScenarioInfo({ twin }: { twin: Twin }) {
  const plan = (twin.baseline.controller as BaselineController).plan;
  const meta = twin.city.meta;
  const cal = calibration(twin);
  const calOk = cal ? cal.filter((c) => c.geh < 5).length : 0;
  const replaysCounts = twin.preset.events.length === 0 && twin.userEvents.length === 0;
  return (
    <section className="panel wide about" id="data">
      <h3>Scenario, data sources &amp; assumptions</h3>
      <p>
        <b>City / corridor:</b> {meta.city}: {meta.corridor}.
      </p>
      <table className="metrics">
        <thead>
          <tr>
            <th>Item</th>
            <th>Status</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {meta.sources.map((s) => (
            <tr key={s.what}>
              <td>{s.what}</td>
              <td>
                <span className={`badge ${/^(Sourced|Measured)/.test(s.status) ? 'ok' : ''}`}>{s.status}</span>
              </td>
              <td>{s.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <b>Baseline used in this run:</b> {plan.label}: {plan.cycle}s common cycle, Webster splits, {plan.progression} green-wave offsets, actuated side phases (gap-out on an empty 30 m detector, skip with no call, early return to the coordinated phase), min greens 5–8s, yellow {SIM_CONSTANTS.yellow}s + all-red {SIM_CONSTANTS.allRed}s. Fixed for the whole run.
      </p>
      {cal && (
        <>
          <b>Calibration: simulated vs. measured approach volumes</b>
          <p className="hint">
            Baseline copy, {twin.city.periodLabels[twin.period]}. GEH = √(2(M−C)²/(M+C)); the common acceptance target for traffic models is GEH &lt; 5 on at least 85% of counts.
            {!replaysCounts && ' This run adds simulated events or surges, so volumes are not expected to match the counts. Use a plain measured preset to check calibration.'}
            {cal.length === 0 && ' Run the simulation past warm-up to see results.'}
          </p>
          {cal.length > 0 && (
            <>
              <p>
                <span className={`badge ${calOk / cal.length >= 0.85 ? 'ok' : ''}`}>
                  {calOk}/{cal.length} approaches GEH &lt; 5 ({Math.round((100 * calOk) / cal.length)}%)
                </span>{' '}
                {twin.done ? 'Full run.' : `Partial run (${fmtClock(twin.t)}); numbers settle as the hour completes.`}
              </p>
              <table className="metrics">
                <thead>
                  <tr>
                    <th>Approach</th>
                    <th>Measured veh/h</th>
                    <th>Simulated veh/h</th>
                    <th>GEH</th>
                  </tr>
                </thead>
                <tbody>
                  {cal.map((c) => (
                    <tr key={c.link}>
                      <td>{c.label}</td>
                      <td className="num">{c.observed.toFixed(0)}</td>
                      <td className="num">{c.simulated.toFixed(0)}</td>
                      <td className={`num ${c.geh < 5 ? 'better' : 'worse'}`}>{c.geh.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
      <b>Limitations</b>
      <ul>
        {meta.limitations.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  );
}
