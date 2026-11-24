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

/* A question board's answer area (Canvas parts, Epo 2026-11-23): a fixed 1,920 ×
 * 1,200 box whose top left the page block keeps (`prop:area`, the board catalog's
 * `area` prop, question boards only), so a saved board carries it into its copies,
 * its previews and its marking image, which draw exactly what lies inside it. A
 * board that stores none has it at (0, 0). */

/** The area's size in board units (W3/W4, Epo 2026-11-07). */
export const AREA_W = 1920;
export const AREA_H = 1200;
/** The page block's key for the area's top left. */
export const AREA_PROP = 'prop:area';

/** The area's box from what the page block stores (`[x, y]`, checked by the
 * board's rules), at (0, 0) when it stores none. */
export function areaBox(stored: unknown): Box {
  const [x, y] = Array.isArray(stored) ? (stored as number[]) : [0, 0];
  return { h: AREA_H, w: AREA_W, x, y };
}
