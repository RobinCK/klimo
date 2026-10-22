/**
 * Seeded pseudo-random numbers (mulberry32). Every consumer derives its own stream from the run seed
 * and a label, so adding a device or a noise source never reshuffles the numbers of the others and a
 * run with the same `KLIMO_SIM_SEED` replays identically.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform in [−amp, amp). */
  jitter(amp: number): number {
    return (this.next() * 2 - 1) * amp;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** FNV-1a of the label mixed into the seed: a stable sub-stream per purpose. */
export function streamSeed(seed: number, label: string): number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function stream(seed: number, label: string): Rng {
  return new Rng(streamSeed(seed, label));
}
