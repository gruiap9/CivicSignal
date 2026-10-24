// Seeded, splittable PRNG (mulberry32). State is a plain number so it can be
// stored in plain-data structures and cloned. Never use Math.random in the sim.

export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x9e;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0 || 1;
}

export class Rng {
  state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Exponential inter-arrival time for a Poisson process with `rate` per second. */
  exp(rate: number): number {
    return -Math.log(1 - this.next()) / rate;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}
