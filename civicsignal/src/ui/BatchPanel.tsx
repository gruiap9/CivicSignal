import { useEffect, useRef, useState } from 'react';
import type { BatchResult, MetricStat } from '../core/batch';
import { METRICS } from '../core/metrics';
import { PRESETS } from '../core/scenario';
import type { TwinConfig } from '../core/twin';
import type { Weights } from '../core/types';
import type { WorkerIn } from './batch.worker';
import { LineChart } from './LineChart';
import { BASE_COLOR, CIVIC_COLOR } from './Panels';

type SweepPoint = { value: number; weights: Weights; stats: MetricStat[] };

export function BatchPanel({ cfg }: { cfg: Omit<TwinConfig, 'seed'> }) {
  const [n, setN] = useState(10);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [sweep, setSweep] = useState<{ term: keyof Weights; points: SweepPoint[]; n: number; presetId: string } | null>(null);
  const [term, setTerm] = useState<keyof Weights>('fairness');
  const worker = useRef<Worker | null>(null);

  useEffect(() => () => worker.current?.terminate(), []);

  const start = (msg: WorkerIn) => {
    worker.current?.terminate();
    const w = new Worker(new URL('./batch.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setProgress({ done: 0, total: 1 });
    w.onmessage = (e) => {
      const d = e.data;
      if (d.kind === 'progress') setProgress({ done: d.done, total: d.total });
      if (d.kind === 'batch') {
        setResult(d.result);
        setProgress(null);
      }
      if (d.kind === 'sweep') {
        setSweep({ term: d.term, points: d.points, n: msg.req.seeds.length, presetId: msg.req.cfg.presetId });
        setProgress(null);
      }
    };
    w.postMessage(msg);
  };
  const seeds = (k: number) => Array.from({ length: k }, (_, i) => 1001 + i);
  const presetName = (id: string) => PRESETS.find((p) => p.id === id)?.name ?? id;

  return (
    <section className="panel wide">
      <h3>Matched multi-seed evaluation</h3>
      <p className="hint">
        Runs the current preset to completion, headless, for N different seeds. Each seed gives both controllers identical demand and events. This is more credible than a single demo run. Uses the current weights and baseline options; live-triggered events are not included.
      </p>
      <div className="row">
        <label>
          Seeds{' '}
          <select value={n} onChange={(e) => setN(Number(e.target.value))}>
            {[5, 10, 20, 30].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <button disabled={!!progress} onClick={() => start({ kind: 'batch', req: { cfg, seeds: seeds(n) } })}>
          Run matched evaluation
        </button>
        <span className="sep" />
        <label>
          Tradeoff sweep of{' '}
          <select value={term} onChange={(e) => setTerm(e.target.value as keyof Weights)}>
            <option value="flow">flow</option>
            <option value="climate">climate</option>
            <option value="transit">transit</option>
            <option value="fairness">fairness</option>
          </select>
        </label>
        <button disabled={!!progress} onClick={() => start({ kind: 'sweep', req: { cfg, seeds: seeds(5) }, term, values: [0, 0.2, 0.4, 0.6, 0.8] })}>
          Sweep (5 seeds × 5 values)
        </button>
        {progress && (
          <span className="muted">
            running… {progress.done}/{progress.total}
          </span>
        )}
      </div>

      {result && (
        <>
          <p>
            <span className="badge">Average across {result.seeds.length} matched seeds</span> {presetName(result.presetId)}. Range = min–max across seeds; “paired change” compares each seed’s CivicSignal run with its own baseline run.
          </p>
          <table className="metrics">
            <thead>
              <tr>
                <th>Metric</th>
                <th style={{ color: BASE_COLOR }}>Baseline mean [range]</th>
                <th style={{ color: CIVIC_COLOR }}>CivicSignal mean [range]</th>
                <th>Paired change [range]</th>
                <th>CivicSignal better in</th>
              </tr>
            </thead>
            <tbody>
              {result.stats.map((s) => {
                const m = METRICS.find((x) => x.key === s.key)!;
                const good = m.better === 'lower' ? s.diff.mean < -0.5 : s.diff.mean > 0.5;
                const bad = m.better === 'lower' ? s.diff.mean > 0.5 : s.diff.mean < -0.5;
                return (
                  <tr key={s.key}>
                    <td>{m.label}</td>
                    <td className="num">
                      {s.base.mean.toFixed(m.digits)} <span className="muted">[{s.base.min.toFixed(m.digits)}–{s.base.max.toFixed(m.digits)}]</span>
                    </td>
                    <td className="num">
                      {s.civic.mean.toFixed(m.digits)} <span className="muted">[{s.civic.min.toFixed(m.digits)}–{s.civic.max.toFixed(m.digits)}]</span>
                    </td>
                    <td className={good ? 'better' : bad ? 'worse' : ''}>
                      {Math.abs(s.diff.mean) < 0.5 ? 'about the same' : `${Math.abs(s.diff.mean).toFixed(1)}% ${s.diff.mean < 0 ? 'lower' : 'higher'}`}{' '}
                      <span className="muted">
                        [{s.diff.min.toFixed(0)}% to {s.diff.max.toFixed(0)}%]
                      </span>
                    </td>
                    <td className="num">
                      {s.civicBetterIn}/{result.seeds.length}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Verdict result={result} />
          {result.ems && (
            <p>
              Emergency vehicle (mean of first vehicle per seed): trip {result.ems.base.toFixed(0)}s baseline vs {result.ems.civic.toFixed(0)}s CivicSignal; extra delay imposed on other traffic {result.ems.baseImpact.toFixed(0)} vs{' '}
              {result.ems.civicImpact.toFixed(0)} veh·s.
            </p>
          )}
        </>
      )}

      {sweep && (
        <>
          <p>
            <span className="badge">Tradeoff sweep · {sweep.n} seeds per point</span> {presetName(sweep.presetId)}. Varying the <b>{sweep.term}</b> weight while the other three keep their proportions. The baseline does not depend on weights, so it is a flat reference.
          </p>
          <div className="charts">
            {(['avgDelayAll', 'maxWait', 'idleVehSec', 'busAvgDelay'] as const).map((k) => {
              const m = METRICS.find((x) => x.key === k)!;
              return (
                <LineChart
                  key={k}
                  title={`${m.label} vs ${sweep.term} weight`}
                  unit={m.unit}
                  digits={m.digits}
                  xLabel={(x) => x.toFixed(2)}
                  series={[
                    { name: 'Baseline', color: BASE_COLOR, points: sweep.points.map((p) => [p.value, p.stats.find((s) => s.key === k)!.base.mean]) },
                    { name: 'CivicSignal', color: CIVIC_COLOR, points: sweep.points.map((p) => [p.value, p.stats.find((s) => s.key === k)!.civic.mean]) },
                  ]}
                />
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function Verdict({ result }: { result: BatchResult }) {
  const lines = result.stats.map((s) => {
    const m = METRICS.find((x) => x.key === s.key)!;
    const improved = m.better === 'lower' ? s.diff.mean < 0 : s.diff.mean > 0;
    if (Math.abs(s.diff.mean) < 0.5) return null;
    return { label: m.label.toLowerCase(), improved, mag: Math.abs(s.diff.mean), dir: s.diff.mean < 0 ? 'lower' : 'higher' };
  });
  const good = lines.filter((l) => l && l.improved);
  const bad = lines.filter((l) => l && !l.improved);
  return (
    <p className="verdict">
      In this model and preset, CivicSignal measured{' '}
      {good.length ? good.map((l) => `${l!.mag.toFixed(0)}% ${l!.dir} ${l!.label}`).join(', ') : 'no improvement on any metric'}
      {bad.length ? `. It did worse on: ${bad.map((l) => `${l!.label} (${l!.mag.toFixed(0)}% ${l!.dir})`).join(', ')}` : ''}. These numbers describe a simplified simulation, not real-world performance.
    </p>
  );
}
