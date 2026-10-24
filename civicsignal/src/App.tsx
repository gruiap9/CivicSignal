import { useCallback, useEffect, useRef, useState } from 'react';
import { summarizeTwin } from './core/metrics';
import { DEFAULT_WEIGHTS, PRESETS, SIM_CONSTANTS } from './core/scenario';
import { Twin, type TwinConfig, type WeightChange } from './core/twin';
import type { SimEvent, Weights } from './core/types';
import type { CivicController } from './control/civic';
import { BatchPanel } from './ui/BatchPanel';
import { fmtClock, LineChart } from './ui/LineChart';
import { NetworkCanvas } from './ui/NetworkCanvas';
import {
  BASE_COLOR,
  CIVIC_COLOR,
  DecisionLog,
  DisruptionPanel,
  EmergencyPanel,
  EmsCard,
  Inspector,
  MetricsTable,
  PolicyPanel,
  ScenarioInfo,
} from './ui/Panels';

const SPEEDS = [1, 2, 5, 10, 30, 60];

interface Setup {
  presetId: string;
  seed: number;
  retimeBaseline: boolean;
  baselinePreemption: boolean;
}

export default function App() {
  const [setup, setSetup] = useState<Setup>({ presetId: 'story', seed: 42, retimeBaseline: false, baselinePreemption: true });
  const [initialTwin] = useState(() => new Twin({ ...setup, weights: DEFAULT_WEIGHTS }));
  const twinRef = useRef<Twin>(initialTwin);
  const [, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [selected, setSelected] = useState<string>('I11');
  const [replay, setReplay] = useState(true);
  const [aboutOpen, setAboutOpen] = useState(true);
  const rerender = useCallback(() => setTick((x) => x + 1), []);
  const twin = twinRef.current;
  // Sliders always show the weights CivicSignal is actually using (including replayed changes).
  const weights = (twin.civic.controller as CivicController).weights;

  const getBase = useCallback(() => twinRef.current.baseline.sim, []);
  const getCivic = useCallback(() => twinRef.current.civic.sim, []);

  // Simulation loop: fixed sim step, decoupled from rendering.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let lastUi = 0;
    const loop = (now: number) => {
      const tw = twinRef.current;
      acc += Math.min(1, (now - last) / 1000) * speed;
      last = now;
      let n = 0;
      while (acc >= tw.dt && n < 600 && !tw.done) {
        tw.step();
        acc -= tw.dt;
        n++;
      }
      if (now - lastUi > 200 || tw.done) {
        lastUi = now;
        rerender();
      }
      if (tw.done) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, rerender]);

  const reset = (next: Setup = setup, opts?: { events?: SimEvent[]; weightChanges?: WeightChange[]; weights?: Weights }) => {
    const old = twinRef.current;
    const keep = replay && next.seed === old.cfg.seed && next.presetId === old.cfg.presetId;
    const cfg: TwinConfig = {
      ...next,
      weights: opts?.weights ?? (keep ? old.cfg.weights : weights),
      extraEvents: opts?.events ?? (keep ? old.userEvents : []),
      weightChanges: opts?.weightChanges ?? (keep ? old.weightChanges : []),
    };
    twinRef.current = new Twin(cfg);
    setSetup(next);
    setPlaying(false);
    rerender();
  };

  const changeWeights = (w: Weights) => {
    twinRef.current.setWeights(w);
    rerender();
  };

  const exportRun = () => {
    const tw = twinRef.current;
    const data = {
      app: 'CivicSignal',
      version: 1,
      note: 'Simulation export. Results describe a simplified model, not real-world traffic.',
      exportedAtSimTime: tw.t,
      config: { ...tw.cfg, extraEvents: undefined, weightChanges: undefined },
      presetEvents: tw.preset.events,
      userEvents: tw.userEvents,
      weightChanges: tw.weightChanges,
      results: { status: tw.done ? 'single run, finished' : 'single run, partial', ...summarizeTwin(tw) },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `civicsignal-${tw.cfg.presetId}-seed${tw.cfg.seed}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importRun = async (file: File) => {
    try {
      const d = JSON.parse(await file.text());
      const c = d.config as TwinConfig;
      reset(
        { presetId: c.presetId, seed: c.seed, retimeBaseline: c.retimeBaseline, baselinePreemption: c.baselinePreemption },
        { events: d.userEvents ?? [], weightChanges: d.weightChanges ?? [], weights: c.weights },
      );
    } catch {
      alert('Could not read that file as a CivicSignal export.');
    }
  };

  const sum = summarizeTwin(twin);
  const status = twin.done ? 'Single-run result · finished' : playing ? 'Live run · single seed' : twin.t > 0 ? 'Live run · paused · single seed' : 'Ready · single seed';
  const series = (key: 'avgDelay' | 'inNet' | 'queued') => [
    { name: 'Baseline', color: BASE_COLOR, points: twin.baseline.sim.state.metrics.series.map((p) => [p.t, p[key]] as [number, number]) },
    { name: 'CivicSignal', color: CIVIC_COLOR, points: twin.civic.sim.state.metrics.series.map((p) => [p.t, p[key]] as [number, number]) },
  ];
  const explanations = twin.civic.log.filter((e) => e.kind === 'switch').slice(-2).reverse();
  const preset = twin.preset;
  const clockStart = preset.clockHour * 3600;
  const clock = (s: number) => {
    const t = clockStart + s;
    return `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  };

  return (
    <div className="app">
      <header>
        <div>
          <h1>
            Civic<span>Signal</span>
          </h1>
          <p className="tag">Traffic-network simulator for comparing a conventional coordinated signal plan with an adaptive network controller under identical conditions.</p>
        </div>
        <a href="#data" className="muted">
          Data &amp; assumptions ↓
        </a>
      </header>

      <section className="panel about-top">
        <button className="link" onClick={() => setAboutOpen(!aboutOpen)}>
          {aboutOpen ? '▾' : '▸'} Why this exists
        </button>
        {aboutOpen && (
          <div>
            <p>
              Traffic congestion costs people significant time and money. INRIX estimated that the typical U.S. driver lost <b>49 hours</b> to congestion in 2025 (
              <a href="https://inrix.com/blog/traffic-is-back-insights-from-the-2025-inrix-global-traffic-scorecard/" target="_blank" rel="noreferrer">
                INRIX 2025 Global Traffic Scorecard
              </a>
              ). CivicSignal tests whether adaptive, network-level signal control can reduce delay in selected traffic scenarios.
            </p>
            <p className="hint">
              The 49-hour figure covers congestion on all roads from many causes (demand, bottlenecks, incidents, work zones), not only traffic lights. CivicSignal results come from a small simulated grid and are <b>not</b> scaled up to national or real-city savings.
            </p>
          </div>
        )}
      </section>

      <section className="toolbar panel">
        <label>
          Scenario{' '}
          <select value={setup.presetId} onChange={(e) => reset({ ...setup, presetId: e.target.value })}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Seed{' '}
          <input type="number" value={setup.seed} style={{ width: 70 }} onChange={(e) => reset({ ...setup, seed: Number(e.target.value) || 1 })} />
        </label>
        <button className="primary" onClick={() => setPlaying(!playing)} disabled={twin.done}>
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button onClick={() => reset()}>↺ Reset</button>
        <label title="When resetting with the same seed and scenario, replay the incidents, surges, emergency dispatches and weight changes you triggered.">
          <input type="checkbox" checked={replay} onChange={(e) => setReplay(e.target.checked)} /> replay my events on reset
        </label>
        <label>
          Speed{' '}
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <span className="clock">
          {clock(twin.t)} <span className="muted">· {fmtClock(twin.t)} / {fmtClock(twin.endT)}</span>
          {twin.t < SIM_CONSTANTS.warmup && <span className="badge">warm-up</span>}
          {twin.t >= preset.duration && <span className="badge">cool-down: no new arrivals</span>}
        </span>
        <span className="badge status">{status}</span>
        <div className="row">
          <label title="Give the baseline a Webster plan tuned to this preset's exact demand instead of its time-of-day plan. Strongest fixed-time baseline.">
            <input type="checkbox" checked={setup.retimeBaseline} onChange={(e) => reset({ ...setup, retimeBaseline: e.target.checked })} /> retime baseline to this demand
          </label>
          <label title="Conventional emergency vehicle preemption (e.g. optical detectors) on the baseline.">
            <input type="checkbox" checked={setup.baselinePreemption} onChange={(e) => reset({ ...setup, baselinePreemption: e.target.checked })} /> baseline has local EV preemption
          </label>
          <button onClick={exportRun}>⤓ Export run</button>
          <label className="file">
            ⤒ Import
            <input type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && importRun(e.target.files[0])} />
          </label>
        </div>
        <p className="hint preset-desc">{preset.description}</p>
      </section>

      <div className="main">
        <div className="left">
          <div className="nets">
            <NetworkCanvas getSim={getBase} selected={selected} onSelect={setSelected} title={`Baseline: ${(twin.plan.label)}, ${twin.plan.cycle}s cycle`} accent={BASE_COLOR} />
            <NetworkCanvas getSim={getCivic} selected={selected} onSelect={setSelected} title="CivicSignal: adaptive network control" accent={CIVIC_COLOR} />
          </div>
          <div className="legend-row muted">
            <span><i className="sw" style={{ background: '#d6d4cc' }} /> moving car</span>
            <span><i className="sw" style={{ background: '#f0a43a' }} /> stopped car</span>
            <span><i className="sw" style={{ background: '#22b8a0' }} /> bus</span>
            <span><i className="sw" style={{ background: '#ff3b3b' }} /> emergency vehicle</span>
            <span><i className="sw" style={{ background: '#ff7a1a' }} /> incident / roadwork lane closure</span>
            <span><b style={{ color: '#e5484d' }}>+n</b> vehicles waiting to enter</span>
            <span>Click an intersection to inspect it</span>
          </div>
          <EventsPanel twin={twin} />
          <div className="charts">
            <LineChart title="Average delay of completed trips" unit="s/veh" series={series('avgDelay')} xMax={twin.endT} digits={1} />
            <LineChart title="Vehicles in network" unit="veh" series={series('inNet')} xMax={twin.endT} />
            <LineChart title="Stopped vehicles" unit="veh" series={series('queued')} xMax={twin.endT} />
          </div>
        </div>
        <aside className="right">
          <PolicyPanel weights={weights} onChange={changeWeights} explanations={explanations} />
          <DisruptionPanel twin={twin} onDone={rerender} />
          <EmergencyPanel twin={twin} onDone={rerender} />
        </aside>
      </div>

      <div className="grid2">
        <div>
          <MetricsTable base={sum.baseline} civic={sum.civic} status={status} />
          <EmsCard twin={twin} base={sum.baseline} civic={sum.civic} />
        </div>
        <div>
          <Inspector twin={twin} node={selected} />
          <DecisionLog twin={twin} />
        </div>
      </div>

      <BatchPanel cfg={{ presetId: setup.presetId, weights, retimeBaseline: setup.retimeBaseline, baselinePreemption: setup.baselinePreemption }} />
      <ScenarioInfo twin={twin} />
      <footer className="muted">
        CivicSignal is a hackathon prototype. Every vehicle, incident and emergency event is simulated. It is not connected to real signals, cameras or dispatch, and its results are not a forecast for any real city.
      </footer>
    </div>
  );
}

function EventsPanel({ twin }: { twin: Twin }) {
  const upcoming = [...twin.preset.events, ...twin.userEvents].filter((e) => !twin.applied.some((a) => a.ev === e) && e.t > twin.t).sort((a, b) => a.t - b.t);
  const sim = twin.civic.sim.state;
  if (!twin.applied.length && !upcoming.length) return null;
  const where = (e: SimEvent) => {
    if (e.kind === 'incident' || e.kind === 'roadwork') {
      const l = twin.net.links[e.link];
      return `${l.name}, ${twin.net.nodes[l.from].name ?? 'network edge'} → ${twin.net.nodes[l.to].name}`;
    }
    if (e.kind === 'surge') return `${e.entries.length} entry approaches`;
    return '';
  };
  return (
    <section className="panel events">
      <b>Events (identical in both copies)</b>
      <ul>
        {twin.applied.map((a, i) => {
          const e = a.ev;
          const active =
            (e.kind === 'incident' || e.kind === 'roadwork') && sim.closures.some((c) => c.link === e.link && c.until === e.t + e.duration)
              ? ' · ACTIVE'
              : e.kind === 'surge' && twin.t < e.t + e.duration
                ? ' · ACTIVE'
                : '';
          return (
            <li key={i}>
              <span className="muted">{fmtClock(e.t)}</span> {e.label}
              {'duration' in e ? ` · ${Math.round(e.duration / 60)} min` : ''}
              {where(e) && <span className="muted"> · {where(e)}</span>}
              <b className="active">{active}</b>
              <span className="muted"> ({a.source})</span>
            </li>
          );
        })}
        {upcoming.map((e, i) => (
          <li key={`u${i}`} className="muted">
            {fmtClock(e.t)} scheduled: {e.label}
          </li>
        ))}
      </ul>
    </section>
  );
}
