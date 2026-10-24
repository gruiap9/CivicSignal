// Headless matched-seed evaluation off the main thread.
import { runBatch, type BatchRequest } from '../core/batch';
import type { Weights } from '../core/types';

export type WorkerIn =
  | { kind: 'batch'; req: BatchRequest }
  | { kind: 'sweep'; req: BatchRequest; term: keyof Weights; values: number[] };

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.kind === 'batch') {
    const result = runBatch(msg.req, (done) => self.postMessage({ kind: 'progress', done, total: msg.req.seeds.length }));
    self.postMessage({ kind: 'batch', result });
    return;
  }
  // Tradeoff sweep: vary one weight; the other three keep their relative proportions.
  const total = msg.values.length * msg.req.seeds.length;
  const points = msg.values.map((val, i) => {
    const base = msg.req.cfg.weights;
    const others = (Object.keys(base) as (keyof Weights)[]).filter((k) => k !== msg.term);
    const rest = others.reduce((a, k) => a + base[k], 0) || 1;
    const w = { ...base, [msg.term]: val } as Weights;
    for (const k of others) w[k] = ((rest === 0 ? 1 / 3 : base[k] / rest) * (1 - val));
    const r = runBatch({ ...msg.req, cfg: { ...msg.req.cfg, weights: w } }, (d) =>
      self.postMessage({ kind: 'progress', done: i * msg.req.seeds.length + d, total }),
    );
    return { value: val, weights: w, stats: r.stats };
  });
  self.postMessage({ kind: 'sweep', term: msg.term, points });
};
