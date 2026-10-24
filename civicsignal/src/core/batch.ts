// Matched multi-seed evaluation: every seed runs baseline and CivicSignal on
// identical demand/events; we report means, ranges and paired differences.

import { METRICS, summarizeTwin, type MetricKey, type Summary } from './metrics';
import { Twin, type TwinConfig } from './twin';

export interface BatchRequest {
  cfg: Omit<TwinConfig, 'seed'>;
  seeds: number[];
}

export interface MetricStat {
  key: MetricKey;
  base: { mean: number; min: number; max: number };
  civic: { mean: number; min: number; max: number };
  /** Paired % change civic vs baseline per seed (negative = lower). */
  diff: { mean: number; min: number; max: number };
  civicBetterIn: number;
}

export interface BatchResult {
  presetId: string;
  seeds: number[];
  stats: MetricStat[];
  ems: { base: number; civic: number; baseImpact: number; civicImpact: number } | null;
  runs: { seed: number; baseline: Summary; civic: Summary }[];
}

const stat = (xs: number[]) => ({
  mean: xs.reduce((a, b) => a + b, 0) / (xs.length || 1),
  min: Math.min(...xs),
  max: Math.max(...xs),
});

export function runBatch(req: BatchRequest, onProgress?: (done: number) => void): BatchResult {
  const runs: BatchResult['runs'] = [];
  req.seeds.forEach((seed, i) => {
    const tw = new Twin({ ...req.cfg, seed });
    tw.runToEnd();
    runs.push({ seed, ...summarizeTwin(tw) });
    onProgress?.(i + 1);
  });
  const stats: MetricStat[] = METRICS.map((m) => {
    const b = runs.map((r) => r.baseline[m.key]);
    const c = runs.map((r) => r.civic[m.key]);
    const d = runs.map((r) => (r.baseline[m.key] ? ((r.civic[m.key] - r.baseline[m.key]) / Math.abs(r.baseline[m.key])) * 100 : 0));
    const better = runs.filter((r) => (m.better === 'lower' ? r.civic[m.key] < r.baseline[m.key] : r.civic[m.key] > r.baseline[m.key])).length;
    return { key: m.key, base: stat(b), civic: stat(c), diff: stat(d), civicBetterIn: better };
  });
  const withEms = runs.filter((r) => r.baseline.ems.length && r.civic.ems.length);
  const ems = withEms.length
    ? {
        base: stat(withEms.map((r) => r.baseline.ems[0].trip)).mean,
        civic: stat(withEms.map((r) => r.civic.ems[0].trip)).mean,
        baseImpact: stat(withEms.map((r) => r.baseline.emsImpact ?? 0)).mean,
        civicImpact: stat(withEms.map((r) => r.civic.emsImpact ?? 0)).mean,
      }
    : null;
  return { presetId: req.cfg.presetId, seeds: req.seeds, stats, ems, runs };
}
