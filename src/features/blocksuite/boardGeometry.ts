import type { Vec } from '@/features/graph/model';

export { curvePieces } from '@/features/graph/curves';
export { snapTo, tidy } from '@/features/graph/marks';
export type { Vec } from '@/features/graph/model';
export { minorStep, ticks } from '@/features/graph/view';

/** Degrees clockwise from 12 o'clock, to the nearest degree, as a protractor reads. */
export function clockAngle([cx, cy]: Vec, [x, y]: Vec) {
  const degrees = (Math.atan2(x - cx, y - cy) * 180) / Math.PI;
  return Math.round((degrees + 360) % 360);
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
