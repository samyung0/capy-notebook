/** Seeded random numbers (FNV-1a hash of the seed string, then mulberry32). */
export class Rng {
  private state: number;

  constructor(seed: string) {
    let h = 2_166_136_261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16_777_619);
    }
    this.state = h >>> 0;
  }

  next() {
    this.state = (this.state + 0x6d_2b_79_f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  uniform(lo: number, hi: number) {
    return lo + (hi - lo) * this.next();
  }

  /** Integer in [lo, hi], both ends included. */
  int(lo: number, hi: number) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  shuffle<T>(items: T[]) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}
