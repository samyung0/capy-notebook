export type Vec = [number, number];

/** Finer squares between a plane's numbered lines: 1 and 5 split in five, 2 in four. */
export function minorStep(step: number) {
  const power = 10 ** Math.floor(Math.log10(step));
  return Math.round(step / power) === 2 ? step / 4 : step / 5;
}

/** Most lines one direction of a plane's grid draws. */
const TICKS_MAX = 1000;

/** The multiples of `every` from `from` to `to`, by index, so a step too small to move
 * a large number can't loop for ever. None past the cap: the grid goes, the tab stays. */
export function ticks(from: number, to: number, every: number) {
  const first = Math.ceil(from / every);
  const last = Math.floor(to / every);
  const count = last - first + 1;
  if (!Number.isFinite(count) || count < 1 || count > TICKS_MAX) return [];
  return Array.from({ length: count }, (_, i) => (first + i) * every);
}

/** The nearest multiple of `step`, without the float dust that would show in a label. */
export function snapTo(value: number, step: number) {
  return Number((Math.round(value / step) * step).toPrecision(12));
}

/** Degrees clockwise from 12 o'clock, to the nearest degree, as a protractor reads. */
export function clockAngle([cx, cy]: Vec, [x, y]: Vec) {
  const degrees = (Math.atan2(x - cx, y - cy) * 180) / Math.PI;
  return Math.round((degrees + 360) % 360);
}

/** A smooth curve through the points (Catmull-Rom), as many short segments. */
export function smoothThrough(points: Vec[], perSegment = 16): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    for (let step = 0; step < perSegment; step++) {
      const t = step / perSegment;
      const at = (axis: 0 | 1) =>
        0.5 *
        (2 * p1[axis] +
          (p2[axis] - p0[axis]) * t +
          (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t * t +
          (3 * p1[axis] - p0[axis] - 3 * p2[axis] + p3[axis]) * t * t * t);
      out.push([at(0), at(1)]);
    }
  }
  const last = points.at(-1);
  if (last) out.push(last);
  return out;
}

export type Box = { h: number; w: number; x: number; y: number };

/** The smallest box around them all. */
export function unite(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { h: bottom - y, w: right - x, x, y };
}

/** The marking image's longest side, drawn at the size the marking model reads (Epo
 * 2026-11-06, 1,568 px): 42-47% smaller than drawing at 2,400 px and shrinking later. */
export const IMAGE_SIDE_MAX = 1568;

/** On a board wider or taller than the marking image, a gap past this between groups
 * of elements shrinks to it in the image, so one dragged far away doesn't squash the
 * rest (Epo 2026-11-06). The board itself is left as it is. */
export const FAR_GAP = 400;

/** Board coordinates in the image: each group of nearby elements keeps its shape, and
 * gaps past FAR_GAP between groups shrink to it. */
export function closeUp(bounds: Box[]) {
  // Groups: bounds within FAR_GAP of each other, joined.
  const group = bounds.map((_, i) => i);
  const root = (i: number): number => {
    if (group[i] !== i) group[i] = root(group[i]);
    return group[i];
  };
  const near = (a: Box, b: Box) =>
    a.x - FAR_GAP <= b.x + b.w &&
    b.x - FAR_GAP <= a.x + a.w &&
    a.y - FAR_GAP <= b.y + b.h &&
    b.y - FAR_GAP <= a.y + a.h;
  for (let i = 0; i < bounds.length; i++)
    for (let j = i + 1; j < bounds.length; j++)
      if (near(bounds[i], bounds[j])) group[root(i)] = root(j);
  const groups = new Map<number, Box>();
  for (const [i, bound] of bounds.entries()) {
    const id = root(i);
    const seen = groups.get(id);
    groups.set(id, seen ? unite([seen, bound]) : bound);
  }
  // Along each axis, the gaps between the groups' spans shrink to FAR_GAP.
  const shifts = (spans: [number, number][]) => {
    const order = [...spans.keys()].sort((a, b) => spans[a][0] - spans[b][0]);
    const shift = new Array<number>(spans.length).fill(0);
    let end = Number.NEGATIVE_INFINITY;
    let taken = 0;
    for (const i of order) {
      const [from, to] = spans[i];
      if (from - end > FAR_GAP && end > Number.NEGATIVE_INFINITY)
        taken += from - end - FAR_GAP;
      shift[i] = taken;
      end = Math.max(end, to);
    }
    return shift;
  };
  const ids = [...groups.keys()];
  const boxes = ids.map((id) => groups.get(id) as Box);
  const dx = shifts(boxes.map((box) => [box.x, box.x + box.w]));
  const dy = shifts(boxes.map((box) => [box.y, box.y + box.h]));
  const by = new Map(ids.map((id, i) => [id, { dx: dx[i], dy: dy[i] }]));
  return bounds.map((_, i) => by.get(root(i)) as { dx: number; dy: number });
}
