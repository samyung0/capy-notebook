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

/** A bar from the x axis in plane units: its column starts where the drag began, it
 * reaches the height the pointer is at, and dragging sideways widens it (a histogram's
 * class). `narrowest` is half a numbered square at the current zoom. */
export function barBetween(
  start: Vec,
  end: Vec,
  minor: number,
  narrowest: number
) {
  const x = snapTo(Math.floor(start[0] / minor) * minor, minor);
  return {
    h: snapTo(end[1], minor),
    w: Math.max(snapTo(end[0] - x, minor), narrowest),
    x,
  };
}

/** Degrees clockwise from 12 o'clock, to the nearest degree, as a protractor reads. */
export function clockAngle([cx, cy]: Vec, [x, y]: Vec) {
  const degrees = (Math.atan2(x - cx, y - cy) * 180) / Math.PI;
  return Math.round((degrees + 360) % 360);
}

/** A point on a circle in plane units, where y goes up. */
export function onCircle([cx, cy]: Vec, radius: number, degrees: number): Vec {
  const turn = (degrees * Math.PI) / 180;
  return [cx + radius * Math.sin(turn), cy + radius * Math.cos(turn)];
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
