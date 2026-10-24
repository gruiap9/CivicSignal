import { test } from 'vitest';
import { runBatch } from './batch';
import { PRESETS, DEFAULT_WEIGHTS } from './scenario';
import { planFor } from './twin';

// Not an assertion test: prints a calibration table. Run with CALIBRATE=1.
test.skipIf(!process.env.CALIBRATE)('calibration report', () => {
  console.log('MIDDAY plan', JSON.stringify(planFor('MIDDAY').cycle), JSON.stringify(planFor('MIDDAY').splits.I11));
  console.log('PM plan', planFor('PM').cycle, JSON.stringify(planFor('PM').splits.I11));
  for (const w of [{ flow: 1, climate: 0, transit: 0, fairness: 0 }, { flow: 0.4, climate: 0, transit: 0, fairness: 0.6 }, { flow: 0.3, climate: 0.6, transit: 0.1, fairness: 0 }, { flow: 0.3, climate: 0, transit: 0.6, fairness: 0.1 }]) {
    const r = runBatch({ cfg: { presetId: 'peak', weights: w, retimeBaseline: false, baselinePreemption: true }, seeds: [1, 2, 3] });
    console.log('[weights]', JSON.stringify(w), r.stats.map((s) => `${s.key} C ${s.civic.mean.toFixed(1)}`).join(' | '));
  }
  for (const p of PRESETS) {
    const t0 = Date.now();
    const r = runBatch({ cfg: { presetId: p.id, weights: DEFAULT_WEIGHTS, retimeBaseline: false, baselinePreemption: true }, seeds: [1, 2, 3] });
    const row = r.stats
      .map((s) => `${s.key}: B ${s.base.mean.toFixed(1)} C ${s.civic.mean.toFixed(1)} (${s.diff.mean.toFixed(0)}%)`)
      .join(' | ');
    console.log(`\n[${p.id}] ${Date.now() - t0}ms  ${row}`);
    if (r.ems) console.log('  ems', JSON.stringify(r.ems));
    console.log('  inNet end B/C', r.runs.map((x) => `${x.baseline.inNetwork}/${x.civic.inNetwork}`).join(' '));
    console.log('  maxWait where B/C', r.runs.map((x) => `${x.baseline.maxWaitWhere}/${x.civic.maxWaitWhere}`).join(' ; '));
  }
}, 120000);
