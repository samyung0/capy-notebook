/* The camera every graph surface shares, and the number rules of its axes. */
import { functionReach } from './curves';
import type { Board, Vec } from './model';

/** The plane's left and top edges in its own units, and screen pixels per
 * unit on each axis (a quiz graph may stretch one). */
export type View = { left: number; top: number; ppuX: number; ppuY: number };

/** How far a surface zooms, in pixels per unit, unchanged per surface (plan
 * step 1): GeoGebra's range in the question editor, the plane's on the canvas. */
export type ZoomRange = { max: number; min: number };
export const QUESTION_ZOOM: ZoomRange = { max: 1e15, min: 1e-15 };
export const PLANE_ZOOM: ZoomRange = { max: 1e6, min: 1e-6 };

type Bbox = Board['bbox'];

/** The view showing `bbox` (left, top, right, bottom) on `w` × `h` pixels. */
export const viewOf = (
  [left, top, right, bottom]: Bbox,
  w: number,
  h: number
) =>
  ({ left, ppuX: w / (right - left), ppuY: h / (top - bottom), top }) as View;

/** What `view` shows on `w` × `h` pixels, as a bbox. */
export const bboxOf = (view: View, w: number, h: number): Bbox => [
  view.left,
  view.top,
  view.left + w / view.ppuX,
  view.top - h / view.ppuY,
];

export const toScreen = (view: View, [x, y]: Vec): Vec => [
  (x - view.left) * view.ppuX,
  (view.top - y) * view.ppuY,
];

export const toPlane = (view: View, [px, py]: Vec): Vec => [
  view.left + px / view.ppuX,
  view.top - py / view.ppuY,
];

/** Moved by a drag of (dx, dy) screen pixels. */
export const panned = (view: View, dx: number, dy: number): View => ({
  ...view,
  left: view.left - dx / view.ppuX,
  top: view.top + dy / view.ppuY,
});

/** Zoomed by `factor` (above 1 zooms in) keeping the plane point under `at`
 * there; a zoom that would leave `range` on either axis stops at its edge. */
export function zoomedAt(
  view: View,
  factor: number,
  at: Vec,
  range: ZoomRange
): View {
  const most = range.max / Math.max(view.ppuX, view.ppuY);
  const least = range.min / Math.min(view.ppuX, view.ppuY);
  const f = Math.max(least, Math.min(most, factor));
  const [x, y] = toPlane(view, at);
  const ppuX = view.ppuX * f;
  const ppuY = view.ppuY * f;
  return { left: x - at[0] / ppuX, ppuX, ppuY, top: y + at[1] / ppuY };
}

/** Dragged points land on the view's precision: 0.1 at about 40 px a unit. */
export function snapped(view: View, [x, y]: Vec): Vec {
  const step = 10 ** Math.floor(Math.log10(10 / view.ppuX));
  const round = (value: number) =>
    Number((Math.round(value / step) * step).toPrecision(12));
  return [round(x), round(y)];
}

/** GeoGebra's tick step: 100px worth of units rounded down to 1, 2 or 5 × 10ⁿ. */
export function tickStep(pixelsPerUnit: number) {
  const units = 100 / pixelsPerUnit;
  const power = 10 ** Math.floor(Math.log10(units));
  const n = units / power;
  return (n > 5 ? 5 : n > 2 ? 2 : 1) * power;
}

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

const LEADING_MINUS = /^-/;
/** axisNumber's formatters by decimals and notation (at most 26; the locale is
 * fixed): building one costs far more than formatting, and a plane formats
 * every tick on every frame. */
const AXIS_FORMATS = new Map<string, Intl.NumberFormat>();

/** A tick number as GeoGebra writes it: plain with enough decimals for the
 * step, scientific (`5E8`) when the step is under 10⁻⁵ or over 10⁷, an en
 * dash for minus; empty at 0, where the axes cross. */
export function axisNumber(value: number, step: number) {
  if (Math.abs(value) < step * 1e-9) return '';
  const digits = Math.min(14, Math.max(-Math.floor(Math.log10(step)), 2));
  const scientific = step < 1e-5 || step > 1e7;
  const key = `${digits}${scientific ? 'e' : ''}`;
  let format = AXIS_FORMATS.get(key);
  if (!format) {
    format = new Intl.NumberFormat('en-US', {
      maximumFractionDigits: digits,
      useGrouping: false,
      ...(scientific && { notation: 'scientific' }),
    });
    AXIS_FORMATS.set(key, format);
  }
  return format.format(value).replace(LEADING_MINUS, '–');
}

/** The view moved up or down to a typed function wholly above or below it
 * across the x range shown (y = 3x + 10000 round the origin), its middle value
 * there in the middle, scale kept (Epo 2026-11-18, "Move the view", though
 * Desmos and GeoGebra stay put). Null when any of it is shown, or crosses,
 * and for an implicit curve. */
export function revealed(
  element: { hidden?: boolean; latex: string },
  view: View,
  w: number,
  h: number
): View | null {
  if (element.hidden) return null;
  const bottom = view.top - h / view.ppuY;
  const ys = functionReach(element, view.left, view.left + w / view.ppuX)?.ys;
  if (!ys || !(ys.every((y) => y > view.top) || ys.every((y) => y < bottom)))
    return null;
  const sorted = [...ys].sort((a, b) => a - b);
  const y = sorted[Math.floor(sorted.length / 2)];
  return { ...view, top: y + h / 2 / view.ppuY };
}

/** The view framing `box` on `w` × `h` pixels, keeping the x and y units'
 * ratio of `like`: the short side grows. */
export function framed(box: Bbox, like: View, w: number, h: number): View {
  const [l, t, r, b] = box;
  const ratio = like.ppuX / like.ppuY;
  const width = Math.max(r - l, ((t - b) * w) / h / ratio);
  const height = (width * ratio * h) / w;
  const cx = (l + r) / 2;
  const cy = (t + b) / 2;
  return viewOf(
    [cx - width / 2, cy + height / 2, cx + width / 2, cy - height / 2],
    w,
    h
  );
}
