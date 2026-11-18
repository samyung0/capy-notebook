/* Curves, functions and implicit curves as points: shared by the engine and
 * the canvas plane. */
import {
  type Expression,
  readExpression,
} from '@/features/questions/graphSyntax';
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

const expressions = new Map<string, Expression | null>();
/** A stored formula row read once, or null for LaTeX it can't read. */
export function markExpression(latex: string) {
  if (!expressions.has(latex)) {
    // Rows typed and retyped add up; reading one again is cheap.
    if (expressions.size > 1000) expressions.clear();
    let read: Expression | null = null;
    try {
      read = readExpression(latex);
    } catch {
      read = null;
    }
    expressions.set(latex, read);
  }
  return expressions.get(latex) ?? null;
}

/** A formula row's function of x, or null for one that is not a function. */
export function markFunction(latex: string) {
  const read = markExpression(latex);
  return read?.kind === 'function' ? read : null;
}

/** A formula row's implicit curve, or null for one that is not an equation. */
export function markEquation(latex: string) {
  const read = markExpression(latex);
  return read?.kind === 'equation' ? read : null;
}

/** Where a function is drawn between two x, as runs of points: a run breaks where
 * it isn't defined or leaps more than `leap` (an asymptote, say). */
export function functionRuns(
  { latex }: { latex: string },
  from: number,
  to: number,
  step: number,
  leap: number
): Vec[][] {
  const read = markFunction(latex);
  if (!read) return [];
  const { at: fn, domain } = read;
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

/** A box on the plane: left, bottom, right, top. */
export type PlaneBox = [number, number, number, number];

/** Halvings along a grid edge where the curve crosses it, closing in on the
 * crossing to a sixteenth of the edge before it is interpolated. */
const CLOSE_IN = 4;
/** The most coarse grid cells across or up, however small the step asked for. */
const GRID_MAX = 600;
/** Traced curves kept for a view drawn again unchanged (a hover, a redraw). */
const TRACED_MAX = 32;
const traced = new Map<string, Vec[][]>();

/** Where an implicit curve F(x, y) = 0 is drawn within a box, as runs of
 * points, `step` (units across and up) its finest cell. Marching squares:
 * F is evaluated on a grid of twice that step, and only cells whose corners
 * differ in sign are split in four, so a typical curve costs a few thousand
 * evaluations. The curve crosses each edge whose ends differ in sign; that
 * crossing is closed in on by halving the edge and then interpolated, so the
 * curve is smooth at any zoom. A pole (1/y) changes sign too, but F grows as
 * it is closed in on rather than shrinking, so that edge is left out and no
 * false line is drawn across it. A zero without a change of sign, as
 * (x − y)² = 0, draws nothing (Desmos draws it; noted, not solved), nor does
 * a loop smaller than a coarse cell. A restriction limits x. The same box and
 * step give the same runs, kept. */
export function equationRuns(
  { latex }: { latex: string },
  box: PlaneBox,
  step: Vec
): Vec[][] {
  const read = markEquation(latex);
  if (!read) return [];
  const key = `${latex}|${box.join()}|${step.join()}`;
  const known = traced.get(key);
  if (known) return known;
  const runs = trace(read, box, step);
  if (traced.size >= TRACED_MAX)
    traced.delete(traced.keys().next().value ?? '');
  traced.set(key, runs);
  return runs;
}

/** Corner values and whether each is known yet, reused across traces. */
let values = new Float64Array(0);
let known = new Uint8Array(0);
/** Each edge's crossing: -2 not looked for, -1 a pole's, else its index. */
let edges = new Int32Array(0);

function trace(
  { at: F, domain }: Extract<Expression, { kind: 'equation' }>,
  [left, bottom, right, top]: PlaneBox,
  [stepX, stepY]: Vec
): Vec[][] {
  const [x0, x1] = domain
    ? [Math.max(left, domain[0]), Math.min(right, domain[1])]
    : [left, right];
  if (!(x1 > x0 && top > bottom && stepX > 0 && stepY > 0)) return [];
  // The coarse grid, then the fine grid of half its cells.
  const nx = Math.min(GRID_MAX, Math.ceil((x1 - x0) / (2 * stepX)));
  const ny = Math.min(GRID_MAX, Math.ceil((top - bottom) / (2 * stepY)));
  const [fx, fy] = [(x1 - x0) / (2 * nx), (top - bottom) / (2 * ny)];
  const row = 2 * nx + 1;
  const size = row * (2 * ny + 1);
  if (values.length < size) {
    values = new Float64Array(size);
    known = new Uint8Array(size);
    edges = new Int32Array(2 * size);
  } else known.fill(0, 0, size);
  edges.fill(-2, 0, 2 * size);
  const value = (i: number, j: number) => {
    const k = j * row + i;
    if (!known[k]) {
      known[k] = 1;
      values[k] = F(x0 + i * fx, bottom + j * fy);
    }
    return values[k];
  };
  // Crossings by edge (key 2k runs right from corner k, 2k + 1 up from it),
  // only where one was looked for. Each has at most two links.
  const px: number[] = [];
  const py: number[] = [];
  const linkA: number[] = [];
  const linkB: number[] = [];
  const crossing = (key: number) => {
    if (edges[key] !== -2) return edges[key];
    const k = key >> 1;
    const i = k % row;
    const j = (k - i) / row;
    const up = key & 1;
    const a = values[k];
    const b = values[up ? k + row : k + 1];
    const ax = x0 + i * fx;
    const ay = bottom + j * fy;
    const ux = up ? 0 : fx;
    const uy = up ? fy : 0;
    let lo = 0;
    let hi = 1;
    let low = a;
    let high = b;
    let defined = true;
    for (let n = 0; n < CLOSE_IN && defined; n++) {
      const t = (lo + hi) / 2;
      const middle = F(ax + ux * t, ay + uy * t);
      defined = Number.isFinite(middle);
      if (middle < 0 === low < 0) {
        lo = t;
        low = middle;
      } else {
        hi = t;
        high = middle;
      }
    }
    const shrank =
      Math.max(Math.abs(low), Math.abs(high)) <=
      Math.max(Math.abs(a), Math.abs(b)) / 4;
    let index = -1;
    if (defined && shrank) {
      const t = lo + ((hi - lo) * low) / (low - high);
      index = px.length;
      px.push(ax + ux * t);
      py.push(ay + uy * t);
      linkA.push(-1);
      linkB.push(-1);
    }
    edges[key] = index;
    return index;
  };
  const link = (a: number, b: number) => {
    if (a < 0 || b < 0) return;
    if (linkA[a] < 0) linkA[a] = b;
    else linkB[a] = b;
    if (linkA[b] < 0) linkA[b] = a;
    else linkB[b] = a;
  };
  const sign = (v: number) => (v < 0 ? 1 : 0);
  /** Whether corners p and q of a cell's mask differ in sign. */
  const differ = (mask: number, p: number, q: number) =>
    ((mask >> p) ^ (mask >> q)) & 1;
  const at = (edge: number) => (edge < 0 ? -2 : crossing(edge));
  // One fine cell from corner (i, j): its edges crossed, joined in pairs.
  const cell = (i: number, j: number) => {
    const v00 = value(i, j);
    const v10 = value(i + 1, j);
    const v11 = value(i + 1, j + 1);
    const v01 = value(i, j + 1);
    if (!Number.isFinite(v00 + v10 + v11 + v01)) return;
    const mask =
      sign(v00) | (sign(v10) << 1) | (sign(v11) << 2) | (sign(v01) << 3);
    if (mask === 0 || mask === 15) return;
    const k = j * row + i;
    const bottomEdge = differ(mask, 0, 1) ? 2 * k : -1;
    const rightEdge = differ(mask, 1, 2) ? 2 * (k + 1) + 1 : -1;
    const topEdge = differ(mask, 2, 3) ? 2 * (k + row) : -1;
    const leftEdge = differ(mask, 3, 0) ? 2 * k + 1 : -1;
    const b = at(bottomEdge);
    const r = at(rightEdge);
    const t = at(topEdge);
    const l = at(leftEdge);
    if (mask === 5 || mask === 10) {
      // A saddle: the middle's sign says which corners join through it.
      const middle = F(x0 + (i + 0.5) * fx, bottom + (j + 0.5) * fy);
      if (sign(middle) === sign(v00)) {
        link(b, r);
        link(t, l);
      } else {
        link(b, l);
        link(r, t);
      }
      return;
    }
    // Two edges are crossed: the first found links to the next.
    const first = b === -2 ? (r === -2 ? t : r) : b;
    const second = l === -2 ? (t !== -2 && first !== t ? t : r) : l;
    link(first, second);
  };
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) value(2 * i, 2 * j);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = 2 * j * row + 2 * i;
      const a = values[k];
      const b = values[k + 2];
      const c = values[k + 2 * row + 2];
      const d = values[k + 2 * row];
      const signs = sign(a) + sign(b) + sign(c) + sign(d);
      // Only a cell the curve may cross is split; one with an undefined
      // corner is split too, so a curve ending at where F is undefined
      // (a root's edge) is still drawn.
      const finite = Number.isFinite(a + b + c + d);
      if (finite && (signs === 0 || signs === 4)) continue;
      cell(2 * i, 2 * j);
      cell(2 * i + 1, 2 * j);
      cell(2 * i, 2 * j + 1);
      cell(2 * i + 1, 2 * j + 1);
    }
  // Linked crossings as runs: open ones from their ends, then loops.
  const runs: Vec[][] = [];
  const walked = new Uint8Array(px.length);
  const walk = (start: number) => {
    const run: Vec[] = [];
    let [previous, at] = [-1, start];
    while (at >= 0 && !walked[at]) {
      walked[at] = 1;
      run.push([px[at], py[at]]);
      const [a, b] = [linkA[at], linkB[at]];
      const next =
        a >= 0 && a !== previous && !walked[a]
          ? a
          : b >= 0 && b !== previous && !walked[b]
            ? b
            : -1;
      previous = at;
      at = next;
    }
    // A loop closes on its start.
    if (
      run.length > 2 &&
      (linkA[previous] === start || linkB[previous] === start)
    )
      run.push(run[0]);
    if (run.length > 1) runs.push(run);
  };
  for (let c = 0; c < px.length; c++)
    if (!walked[c] && linkA[c] >= 0 && linkB[c] < 0) walk(c);
  for (let c = 0; c < px.length; c++) if (!walked[c] && linkA[c] >= 0) walk(c);
  return runs;
}

/** Grid cells across the box an implicit curve is framed over. */
const REACH_CELLS = 150;

/** Where an implicit curve reaches for framing it round `shown`, as points:
 * it is looked for over a box three times as wide and tall. A part closed
 * within that box counts whole (a circle crossing the shown edge), as other
 * apps fit to what is drawn; a part running on to the box's edge (the lines
 * of x² − y² = 0) counts within `shown` and keeps the shown edges it runs
 * past, as a function does, so fitting again finds the same frame. One never
 * within `shown` counts whole, so the frame moves to it; with none in the
 * box, one is looked for ten times as wide (Epo 2026-11-18). */
export function equationReach(
  element: { latex: string },
  [left, bottom, right, top]: PlaneBox
): Vec[] {
  // A shown range collapsed to a line or point still has a box round it.
  const span = Math.max(right - left, top - bottom) || 1;
  const [w, h] = [right - left || span, top - bottom || span];
  const [cx, cy] = [(left + right) / 2, (bottom + top) / 2];
  const near: PlaneBox = [
    cx - 1.5 * w,
    cy - 1.5 * h,
    cx + 1.5 * w,
    cy + 1.5 * h,
  ];
  const [stepX, stepY] = [(3 * w) / REACH_CELLS, (3 * h) / REACH_CELLS];
  const runs = equationRuns(element, near, [stepX, stepY]);
  if (!runs.length) {
    const far: PlaneBox = [cx - 15 * w, cy - 15 * h, cx + 15 * w, cy + 15 * h];
    return equationRuns(element, far, [10 * stepX, 10 * stepY]).flat();
  }
  const inside = ([x, y]: Vec) =>
    x >= left && x <= right && y >= bottom && y <= top;
  if (!runs.some((run) => run.some(inside))) return runs.flat();
  const open = (run: Vec[]) =>
    run.some(
      ([x, y]) =>
        x <= near[0] + stepX ||
        x >= near[2] - stepX ||
        y <= near[1] + stepY ||
        y >= near[3] - stepY
    );
  return runs.flatMap((run) =>
    open(run)
      ? run.map(
          ([x, y]): Vec => [
            Math.min(right, Math.max(left, x)),
            Math.min(top, Math.max(bottom, y)),
          ]
        )
      : run
  );
}

/** Samples a framing takes across a function: as many steps as Fit always took. */
const REACH_STEPS = 100;
/** Past this a value counts as running off (the engine's own drawing bound). */
const RUNS_OFF = 1e6;

const runsOff = (y: number) => !Number.isFinite(y) || Math.abs(y) >= RUNS_OFF;

/** Whether `fn` runs off to infinity between `a` and `b` (an asymptote) rather
 * than peaking: halved towards its larger end until it runs off, or settles
 * (a smooth peak, however narrow, stays finite). */
function asymptoteBetween(fn: (x: number) => number, from: number, to: number) {
  let [a, b] = [from, to];
  let [ya, yb] = [fn(a), fn(b)];
  for (let i = 0; i < 48; i++) {
    const middle = (a + b) / 2;
    const y = fn(middle);
    if (runsOff(y)) return true;
    if (Math.abs(ya) > Math.abs(yb)) [b, yb] = [middle, y];
    else [a, ya] = [middle, y];
  }
  return false;
}

/** Where a function reaches between two x, for framing it (Fit, Fit to size):
 * its x range (`from`–`to` within its domain) and its values at 101 even steps.
 * One that runs off there (an asymptote: infinite at a step, as 1/x at 0, or
 * between two, as tan) leaves out values past Tukey's far fences, three
 * interquartile ranges out, so it frames its body rather than its spikes, as
 * Mathematica's automatic plot range drops outlying points (Epo 2026-11-18).
 * Any other keeps every value: eˣ's steep end, a narrow peak, ln x beside
 * where it is undefined. Null for a row that is not a function or a domain outside
 * the range. */
export function functionReach(
  { latex }: { latex: string },
  from: number,
  to: number
): { x: [number, number]; ys: number[] } | null {
  const read = markFunction(latex);
  if (!read) return null;
  const { at: fn, domain } = read;
  const [low, high] = domain
    ? [Math.max(from, domain[0]), Math.min(to, domain[1])]
    : [from, to];
  if (!(low <= high)) return null;
  const ys: number[] = [];
  let asymptote = false;
  let last: Vec | null = null;
  for (let i = 0; i <= REACH_STEPS; i++) {
    const x = low + ((high - low) * i) / REACH_STEPS;
    const y = fn(x);
    // Undefined (ln x left of 0) is a gap, not a spike.
    if (Number.isNaN(y)) {
      last = null;
      continue;
    }
    if (runsOff(y)) {
      asymptote = true;
      last = null;
      continue;
    }
    // Only where the value between isn't between: a steep rise is checked
    // no further.
    if (last && !asymptote) {
      const middle = fn((last[0] + x) / 2);
      if (
        !(middle >= Math.min(last[1], y) && middle <= Math.max(last[1], y)) &&
        asymptoteBetween(fn, last[0], x)
      )
        asymptote = true;
    }
    ys.push(y);
    last = [x, y];
  }
  if (!ys.length) return null;
  if (!asymptote) return { x: [low, high], ys };
  const sorted = [...ys].sort((a, b) => a - b);
  const quartile = (q: number) => sorted[Math.round((sorted.length - 1) * q)];
  const spread = quartile(0.75) - quartile(0.25);
  const [lowFence, highFence] = [
    quartile(0.25) - 3 * spread,
    quartile(0.75) + 3 * spread,
  ];
  return {
    x: [low, high],
    ys: ys.filter((y) => y >= lowFence && y <= highFence),
  };
}
