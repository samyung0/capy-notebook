/* Curves and functions as points: shared by the engine and the canvas plane. */
import { functionOf } from '@/features/questions/graphSyntax';
import type { Vec } from './model';

/** The four points a Catmull-Rom segment from `points[i]` to the next reads. A curve
 * that ends on its first point is a loop, so its ends read across the join. */
function around(points: Vec[], i: number): [Vec, Vec, Vec, Vec] {
  const first = points[0];
  const end = points.at(-1);
  const loop =
    points.length > 3 && end?.[0] === first[0] && end[1] === first[1];
  const p1 = points[i];
  const p2 = points[i + 1];
  return [
    points[i - 1] ?? ((loop && points.at(-2)) || p1),
    p1,
    p2,
    points[i + 2] ?? (loop ? points[1] : p2),
  ];
}

/** The same curve as cubic Bézier pieces, `[from, control, control, to]`, which a
 * canvas draws smooth at any zoom. */
export function curvePieces(points: Vec[]): [Vec, Vec, Vec, Vec][] {
  return points.slice(0, -1).map((_, i) => {
    const [p0, p1, p2, p3] = around(points, i);
    return [
      p1,
      [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      p2,
    ];
  });
}

/** A curve's pieces as cubic Béziers: from, its two controls, to. Without
 * `handles` (each point's [in, out]) it bends smoothly through its points. */
export function curveSegments(
  points: Vec[],
  handles?: [Vec, Vec][]
): [Vec, Vec, Vec, Vec][] {
  if (!handles) return curvePieces(points);
  return points
    .slice(0, -1)
    .map((from, i) => [from, handles[i][1], handles[i + 1][0], points[i + 1]]);
}

const functions = new Map<string, ((x: number) => number) | null>();
/** A stored term's function of x, or null for a term it can't read. */
export function markFunction(term: string) {
  if (!functions.has(term)) {
    let fn: ((x: number) => number) | null = null;
    try {
      fn = functionOf(term);
    } catch {
      fn = null;
    }
    functions.set(term, fn);
  }
  return functions.get(term) ?? null;
}

/** Where a function is drawn between two x, as runs of points: a run breaks where
 * it isn't defined or leaps more than `leap` (an asymptote, say). */
export function functionRuns(
  { domain, term }: { domain?: [number, number]; term: string },
  from: number,
  to: number,
  step: number,
  leap: number
): Vec[][] {
  const fn = markFunction(term);
  if (!fn) return [];
  const [low, high] = domain
    ? [Math.max(from, domain[0]), Math.min(to, domain[1])]
    : [from, to];
  const runs: Vec[][] = [];
  let run: Vec[] = [];
  const count = Math.min(4000, Math.ceil((high - low) / step));
  const gap = (high - low) / Math.max(count, 1);
  // A leap past `leap` breaks the run only where the value between isn't between,
  // as at tan's or 1/x's asymptote; a steep line keeps drawing.
  const jumps = ([x0, y0]: Vec, x: number, y: number) => {
    if (Math.abs(y - y0) <= leap) return false;
    const middle = fn((x0 + x) / 2);
    return !(middle >= Math.min(y0, y) && middle <= Math.max(y0, y));
  };
  for (let i = 0; i <= count; i++) {
    const x = i === count ? high : low + i * gap;
    const y = fn(x);
    const last = run.at(-1);
    if (!Number.isFinite(y) || (last && jumps(last, x, y))) {
      if (run.length > 1) runs.push(run);
      run = Number.isFinite(y) ? [[x, y]] : [];
    } else run.push([x, y]);
  }
  if (run.length > 1) runs.push(run);
  return runs;
}
