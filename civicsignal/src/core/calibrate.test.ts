import { test } from 'vitest';
import { runBatch } from './batch';
import { CITIES } from './cities';
import { calibration, summarizeTwin } from './metrics';
import { DEFAULT_WEIGHTS } from './scenario';
import { planFor, Twin } from './twin';

// Not an assertion test: prints a calibration report. Run with `npm run calibrate`.
test.skipIf(!process.env.CALIBRATE)('calibration report', () => {
  for (const city of CITIES) {
    const pm = planFor(city, 'PM');
    console.log(`\n===== ${city.name}: PM plan cycle ${pm.cycle}s, progression ${pm.progression}`);
    for (const id of city.net.signals.slice(0, 3)) console.log(`  ${id} coord ${pm.coord[id]} seq ${pm.seq[id].join(',')} splits ${JSON.stringify(pm.splits[id])} offset ${pm.offsets[id]}`);
    for (const p of city.presets) {
      const t0 = Date.now();
      const cfg = { cityId: city.id, presetId: p.id, weights: DEFAULT_WEIGHTS, retimeBaseline: false, baselinePreemption: true };
      const r = runBatch({ cfg, seeds: [1, 2, 3] });
      const row = r.stats.map((s) => `${s.key}: B ${s.base.mean.toFixed(1)} C ${s.civic.mean.toFixed(1)} (${s.diff.mean.toFixed(0)}%)`).join(' | ');
      console.log(`\n[${city.id}/${p.id}] ${Date.now() - t0}ms  ${row}`);
      if (r.ems) console.log('  ems', JSON.stringify(r.ems));
      console.log('  inNet end B/C', r.runs.map((x) => `${x.baseline.inNetwork}/${x.civic.inNetwork}`).join(' '));
      if (city.observed && p.events.length === 0) {
        const tw = new Twin({ ...cfg, seed: 1 });
        tw.runToEnd();
        const cal = calibration(tw)!;
        const ok = cal.filter((c) => c.geh < 5).length;
        console.log(`  calibration: ${ok}/${cal.length} approaches GEH<5; worst: ${cal.slice(0, 4).map((c) => `${c.label} obs ${c.observed.toFixed(0)} sim ${c.simulated.toFixed(0)} GEH ${c.geh.toFixed(1)}`).join(' ; ')}`);
        void summarizeTwin;
      }
    }
  }
}, 600000);
