export type Vec = [number, number];

/** The sheet an answer is drawn on, in the board's own coordinates, with one
 * grid square a unit: the origin is where the axes cross. */
export const SHEET = { h: 520, origin: { x: 41, y: 360 }, w: 820, x: 0, y: 0 };
export const UNIT = { x: 41, y: 40 };

/** The nearest grid crossing, or null off the sheet. */
export function snapToGrid([x, y]: Vec): Vec | null {
  if (
    x < SHEET.x ||
    x > SHEET.x + SHEET.w ||
    y < SHEET.y ||
    y > SHEET.y + SHEET.h
  )
    return null;
  return [
    Math.round((x - SHEET.origin.x) / UNIT.x) * UNIT.x + SHEET.origin.x,
    Math.round((y - SHEET.origin.y) / UNIT.y) * UNIT.y + SHEET.origin.y,
  ];
}

/** A grid crossing as the student reads it off the axes: "(3, −1)". */
export function coordinates([x, y]: Vec) {
  const value = (n: number) => `${n}`.replace('-', '−');
  return `(${value((x - SHEET.origin.x) / UNIT.x)}, ${value((SHEET.origin.y - y) / UNIT.y)})`;
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
