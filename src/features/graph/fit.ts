import {
  equationReach,
  functionReach,
  markEquation,
  markFunction,
  type PlaneBox,
} from './curves';
import { textBox } from './draw';
import { formulaBox, laidOut } from './formula';
import { pointsById, pointsOf } from './marks';
import { type GraphElement, LABEL_SIZE } from './model';

type Vec = [number, number];

/** Fit to size: the room left around the marks, and the longest side before it zooms
 * out instead of growing. */
const FIT_PAD = 40;
export const FIT_SIDE_MAX = 1600;

/** Every point a plane's marks reach (a curve's handles too, a circle round its
 * centre). Not the origin: other apps fit to what is drawn (Matplotlib's
 * autoscale, Desmos's Zoom Fit), so a graph far from it isn't shrunk to a speck
 * to keep it (Epo 2026-11-18). A formula row reaches none here: `fitMarks`
 * samples it (`functionReach`, `equationReach`). */
export function markPoints(marks: readonly GraphElement[]) {
  const centres = pointsById(marks);
  return [
    ...marks.flatMap((mark): Vec[] => {
      const centre = mark.type === 'circle' && centres.get(mark.center);
      return [
        ...pointsOf(mark),
        ...(mark.type === 'curve' && mark.handles ? mark.handles.flat() : []),
        ...(centre && mark.type === 'circle'
          ? ([
              [centre[0] - mark.radius, centre[1] - mark.radius],
              [centre[0] + mark.radius, centre[1] + mark.radius],
            ] as Vec[])
          : []),
      ];
    }),
  ];
}

/** A canvas only for measuring text, made once. */
let measurer: CanvasRenderingContext2D | null = null;

/** How far each label's and formula's text reaches past its point, in pixels: as
 * much at any scale, so Fit to size keeps sized text on the frame (Epo 2026-11-13).
 * A formula not laid out yet counts as its point. */
function textReach(marks: readonly GraphElement[]) {
  return marks.flatMap((mark) => {
    if (mark.type === 'text') {
      measurer ??= document.createElement('canvas').getContext('2d');
      if (!measurer) return [];
      const { h, w } = textBox(
        measurer,
        mark.text,
        mark.size ?? LABEL_SIZE,
        0,
        0
      );
      return [{ at: mark.coords, x: w / 2, y: h / 2 }];
    }
    const drawn = mark.type === 'formula' && laidOut(mark.latex);
    if (!drawn || mark.type !== 'formula') return [];
    const { h, w } = formulaBox(drawn, 0, 0, mark.size);
    return [{ at: mark.coords, x: w / 2, y: h / 2 }];
  });
}

/** Fit to size, as a canvas plane card and a graph figure both do on leaving their
 * editor (Epo 2026-11-18): a frame round every mark and label at `ppu` (pixels per
 * unit across and up), zoomed out instead past the longest side. `x0`/`y0` is the
 * frame's top left on the plane, `w`/`h` its size in pixels. Null when there is
 * nothing to frame (no marks, and no function with a value over the x range): the frame
 * stays as it is. */
export function fitMarks(
  marks: readonly GraphElement[],
  ppu: { x: number; y: number },
  size: { max: number; minH: number; minW: number },
  /** What is shown now: functions count across its x range and the marks',
   * within its y range (Epo 2026-11-18, so x² or eˣ doesn't stretch the frame
   * past what was looked at); implicit curves' open parts within it. */
  shown: { x: [number, number]; y: [number, number] }
) {
  const seen = markPoints(marks);
  const xs = seen.map(([x]) => x);
  const ys = seen.map(([, y]) => y);
  // What is shown less the room a fit leaves round it, so fitting again keeps
  // the frame rather than growing it by that room each time.
  const inside = ([from, to]: [number, number], scale: number) => {
    const room = FIT_PAD / scale;
    return to - from > 2 * room
      ? [from + room, to - room]
      : [(from + to) / 2, (from + to) / 2];
  };
  const [shownLeft, shownRight] = inside(shown.x, ppu.x);
  const [shownBottom, shownTop] = inside(shown.y, ppu.y);
  // Functions as the Fit button samples them, spikes left out, across where
  // they are drawn and the marks, as a plotted curve counts over its plotted
  // range in Matplotlib and Mathematica (Epo 2026-11-18: copy other apps).
  const [from, to] = [Math.min(shownLeft, ...xs), Math.max(shownRight, ...xs)];
  // What is shown and the marks' reach, round which implicit curves count.
  const around: PlaneBox = [
    from,
    Math.min(shownBottom, ...ys),
    to,
    Math.max(shownTop, ...ys),
  ];
  let reached = false;
  for (const mark of marks) {
    if (mark.type !== 'expression' || mark.hidden) continue;
    // An implicit curve's closed parts count whole, the rest within that
    // range (`equationReach`).
    if (markEquation(mark.latex)) {
      const found = equationReach(mark, around);
      if (!found.length) continue;
      reached = true;
      xs.push(...found.map(([x]) => x));
      ys.push(...found.map(([, y]) => y));
      continue;
    }
    // A restriction's bounds widen the range; an open one (x ≥ 0) doesn't.
    const [low, high] = markFunction(mark.latex)?.domain ?? [from, to];
    const reach = functionReach(
      mark,
      Number.isFinite(low) ? Math.min(from, low) : from,
      Number.isFinite(high) ? Math.max(to, high) : to
    );
    if (!reach?.ys.length) continue;
    reached = true;
    xs.push(...reach.x);
    const within = reach.ys.filter((y) => y >= shownBottom && y <= shownTop);
    // Wholly above or below what is shown (y = 3x + 10000 on a plane round
    // the origin), all of it counts: the frame moves to where it is. A steep
    // line crossing between samples is not that.
    if (
      reach.ys.every((y) => y > shownTop) ||
      reach.ys.every((y) => y < shownBottom)
    ) {
      ys.push(...reach.ys);
      continue;
    }
    ys.push(...within);
    // Running past an edge shown, it keeps that edge: the curve still leaves
    // there, and fitting again finds the same frame.
    if (reach.ys.some((y) => y > shownTop)) ys.push(shownTop);
    if (reach.ys.some((y) => y < shownBottom)) ys.push(shownBottom);
  }
  if (!(seen.length || reached)) return null;
  const room = size.max - FIT_PAD * 2;
  const span = (values: number[]) =>
    Math.max(Math.max(...values) - Math.min(...values), 1e-6);
  // Zoomed out evenly, so a figure's unequal units keep their ratio.
  const k = Math.min(1, room / (span(xs) * ppu.x), room / (span(ys) * ppu.y));
  const [px, py] = [ppu.x * k, ppu.y * k];
  // The plane's pixels at that scale: the points, and the text round its own.
  const texts = textReach(marks);
  const left = Math.min(
    ...xs.map((x) => x * px),
    ...texts.map((t) => t.at[0] * px - t.x)
  );
  const right = Math.max(
    ...xs.map((x) => x * px),
    ...texts.map((t) => t.at[0] * px + t.x)
  );
  const bottom = Math.min(
    ...ys.map((y) => y * py),
    ...texts.map((t) => t.at[1] * py - t.y)
  );
  const top = Math.max(
    ...ys.map((y) => y * py),
    ...texts.map((t) => t.at[1] * py + t.y)
  );
  const clamp = (value: number, low: number) =>
    Math.max(low, Math.min(size.max, value));
  const w = clamp(right - left + FIT_PAD * 2, size.minW);
  const h = clamp(top - bottom + FIT_PAD * 2, size.minH);
  return {
    h,
    ppu: { x: px, y: py },
    /** Whether what it framed has any extent on the plane: a lone point or
     * label has none, its frame the same size at every scale. */
    spread:
      Math.max(...xs) > Math.min(...xs) || Math.max(...ys) > Math.min(...ys),
    w,
    x0: ((left + right) / 2 - w / 2) / px,
    y0: ((top + bottom) / 2 + h / 2) / py,
  };
}

type Bbox = [number, number, number, number];

/** Fit to size for a graph figure, which keeps its size (Epo 2026-11-18, as
 * Desmos's Zoom Fit and Matplotlib's autoscale fit the window, not the
 * picture): the frame `fitMarks` finds, scaled to fill `width` × `height` and
 * centred, its units' ratio kept. That frame depends on what is shown (its
 * room, the y range functions count within), so it is fitted again until it
 * settles: the first fit lands where any later one would. Null when there is
 * nothing to frame, or the window has no width or height. */
export function fitWindow(
  marks: readonly GraphElement[],
  { height, width }: { height: number; width: number },
  bbox: Bbox,
  size: { max: number; minH: number; minW: number }
): Bbox | null {
  let box = bbox;
  for (let pass = 0; pass < 40; pass++) {
    const [left, top, right, bottom] = box;
    // A window with no width or height has no scale to fit at.
    if (!(right > left && top > bottom)) return null;
    const fitted = fitMarks(
      marks,
      { x: width / (right - left), y: height / (top - bottom) },
      size,
      { x: [left, right], y: [bottom, top] }
    );
    if (!fitted) return pass ? box : null;
    const { h, ppu, spread, w, x0, y0 } = fitted;
    // Something with no extent (one point, one label) is framed at the scale
    // it has: zooming in would never fill the figure, only shrink the window.
    const k = Math.min(
      width / w,
      height / h,
      spread ? Number.POSITIVE_INFINITY : 1
    );
    const [cx, cy] = [x0 + w / ppu.x / 2, y0 - h / ppu.y / 2];
    const [halfW, halfH] = [width / (ppu.x * k) / 2, height / (ppu.y * k) / 2];
    const next: Bbox = [cx - halfW, cy + halfH, cx + halfW, cy - halfH];
    const settled = next.every(
      (value, i) => Math.abs(value - box[i]) <= 1e-9 * (halfW + halfH)
    );
    box = next;
    if (settled) break;
  }
  return box;
}

/** The editor's Fit (its ☰ menu): the window `fitWindow` settles on for a
 * `width` × `height` view showing `bbox` (40 px round the marks, functions
 * and open curves within the range shown, closed curves whole), so pressing
 * it again changes nothing (Epo 2026-11-18). At least `span` units each way,
 * so an empty graph (framed round the origin) or one point shows a stretch
 * of grid round it (Epo 2026-11-13). */
export function fitPressed(
  marks: readonly GraphElement[],
  size: { height: number; width: number },
  bbox: Bbox,
  span: number
): Bbox {
  const fitted = fitWindow(marks, size, bbox, {
    max: Math.max(size.width, size.height),
    minH: 0,
    minW: 0,
  });
  const [l, t, r, b] = fitted ?? [-span / 2, span / 2, span / 2, -span / 2];
  const k = Math.max(1, span / (r - l), span / (t - b));
  const [cx, cy] = [(l + r) / 2, (t + b) / 2];
  const [halfW, halfH] = [((r - l) * k) / 2, ((t - b) * k) / 2];
  return [cx - halfW, cy + halfH, cx + halfW, cy - halfH];
}
