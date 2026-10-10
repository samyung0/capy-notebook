/**
 * Hand-drawn stroke helpers for the question bank progress map. Everything is
 * seeded, so the same input always draws the same wobble.
 */

export type Pt = readonly [number, number];

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

/** Last point of a polyline, which always has one. */
export const lastOf = (pts: readonly Pt[]) => pts.at(-1) as Pt;

/** One decimal is plenty at map scale and keeps the markup small. */
export const n = (v: number) => String(Math.round(v * 10) / 10);

/** Text placed in the map's markup. */
export const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const polyD = (pts: readonly Pt[]) =>
  `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(' ')}`;

/** Dense polyline through pts (Catmull-Rom). */
export function catmull(pts: readonly Pt[], steps = 10): Pt[] {
  const out: Pt[] = [];
  const p = [pts[0], ...pts, lastOf(pts)];
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const at = (k: 0 | 1) =>
        0.5 *
        (2 * p1[k] +
          (-p0[k] + p2[k]) * t +
          (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
          (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      out.push([at(0), at(1)]);
    }
  }
  out.push(lastOf(pts));
  return out;
}

/** Subdivide a polyline and nudge points sideways, like a hand. Ends stay put. */
export function wobble(pts: readonly Pt[], rng: Rng, amp = 1.2, every = 14) {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.floor(len / every));
    const nx = len ? -(y1 - y0) / len : 0;
    const ny = len ? (x1 - x0) / len : 0;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const a = k < steps ? rng.uniform(-amp, amp) : 0;
      out.push([x0 + (x1 - x0) * t + nx * a, y0 + (y1 - y0) * t + ny * a]);
    }
  }
  return out;
}

/** Slightly different strokes over the same line. */
export function sketch(
  pts: readonly Pt[],
  rng: Rng,
  cls: string,
  { amp = 1.1, passes = 2, smooth = true } = {}
) {
  let s = '';
  for (let i = 0; i < passes; i++) {
    const w = wobble(pts, rng, amp);
    s += `<path class="tm-${cls}" d="${polyD(smooth ? catmull(w, 4) : w)}"/>`;
  }
  return s;
}

/** Single-pass straight strokes, the common case for small parts. */
export const line = (rng: Rng, pts: readonly Pt[], cls = 'ink', amp = 0.35) =>
  sketch(pts, rng, cls, { amp, passes: 1, smooth: false });

/** A filled shape; with an rng its edge wobbles too. */
export function fill(pts: readonly Pt[], cls: string, rng?: Rng, amp = 0.4) {
  return `<path class="tm-${cls}" d="${polyD(rng ? wobble(pts, rng, amp) : pts)}Z"/>`;
}

/** Short parallel strokes inside a convex polygon, merged into one path. */
export function hatch(
  poly: readonly Pt[],
  rng: Rng,
  angle: number,
  gap: number,
  cls: string,
  keep = 0.85
) {
  const a = (angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const ds = poly.map(([x, y]) => -x * dy + y * dx);
  const max = Math.max(...ds);
  let d = Math.min(...ds) + gap * 0.5;
  let path = '';
  while (d < max) {
    const hits: Pt[] = [];
    poly.forEach(([x0, y0], i) => {
      const [x1, y1] = poly[(i + 1) % poly.length];
      const d0 = -x0 * dy + y0 * dx - d;
      const d1 = -x1 * dy + y1 * dx - d;
      if (d0 * d1 < 0) {
        const t = d0 / (d0 - d1);
        hits.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      }
    });
    if (hits.length >= 2 && rng.next() < keep) {
      hits.sort((p, q) => p[0] * dx + p[1] * dy - (q[0] * dx + q[1] * dy));
      const [ax, ay] = hits[0];
      const [bx, by] = lastOf(hits);
      const len = Math.hypot(bx - ax, by - ay);
      const s0 = rng.uniform(0, 0.25) * len;
      const s1 = rng.uniform(0, 0.3) * len;
      if (len - s0 - s1 > 4) {
        const px = ax + dx * s0 + rng.uniform(-0.6, 0.6);
        const qy = by - dy * s1 + rng.uniform(-0.6, 0.6);
        path += `M${n(px)} ${n(ay + dy * s0)} ${n(bx - dx * s1)} ${n(qy)}`;
      }
    }
    d += gap * rng.uniform(0.75, 1.25);
  }
  return path ? `<path class="tm-${cls}" d="${path}"/>` : '';
}
