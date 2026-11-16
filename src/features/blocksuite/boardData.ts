import { BOARD_CATALOG } from '@/api/board.generated';
import {
  curvePieces,
  curveSegments as segmentsOf,
} from '@/features/graph/curves';
import { EXPORT_PAPER, PAPER, type Paper } from '@/features/graph/paper';
import { type Box, tidy, type Vec } from './boardGeometry';

export { functionRuns, markFunction } from '@/features/graph/curves';
export { INK, NUMBER, PAPER, type Paper, TEXT } from '@/features/graph/paper';

/** What a saved board's cards hold, and their limits, apart from the editor: the
 * board's check and its preview read them without loading BlockSuite. */

/** A board colour, as BlockSuite's `Color` stores it. */
export type Color =
  | string
  | { normal: string }
  | { dark: string; light: string };

/** What's plotted on a plane, in its own units. A line or curve grows a click at a time,
 * each click one undo step. A label is text centred on its point (Epo 2026-11-08). An
 * ellipse (Epo 2026-11-08) is upright, held by its four handles: right, top, left and
 * bottom, so it starts as a circle and its handles stretch it. A formula (Epo
 * 2026-11-08) is LaTeX centred on its point, drawn by KaTeX. A vector is a line
 * from its first point to its second, with an arrowhead there. A curve's `handles`
 * (Epo 2026-11-13) are each point's [in, out] Bézier handles, set once one is
 * pulled; without them it bends smoothly through its points. A function (Epo
 * 2026-11-13) is typed in the objects list: `term` in the graph dialog's syntax,
 * `latex` as typed, drawn across the plane or its `domain`. A label's or formula's
 * `size` (Epo 2026-11-13) is its text size in pixels, set by its frame's corners;
 * without one it's LABEL_SIZE or FORMULA_SIZE. Text keeps its size as the plane zooms. */
export type Mark =
  | { id: string; kind: 'dot'; at: Vec }
  | { id: string; kind: 'label'; at: Vec; text: string; size?: number }
  | { id: string; kind: 'formula'; at: Vec; latex: string; size?: number }
  | {
      id: string;
      kind: 'line' | 'vector' | 'curve' | 'ellipse';
      points: Vec[];
      handles?: [Vec, Vec][];
    }
  | {
      id: string;
      kind: 'function';
      latex: string;
      term: string;
      domain?: [number, number];
    };

export type PathMark = Extract<Mark, { points: Vec[] }>;
export type FunctionMark = Extract<Mark, { kind: 'function' }>;

/** The points a mark is drawn through, or at; a function has none. */
export const pointsOf = (mark: Mark): Vec[] =>
  'points' in mark ? mark.points : 'at' in mark ? [mark.at] : [];

/** Whether a curve closes on its start, as `curvePieces` takes it: its first and last
 * points are one point, smooth across the seam. */
export const isLoop = (points: Vec[]) => {
  const [first, end] = [points[0], points.at(-1)];
  return points.length > 3 && end?.[0] === first[0] && end[1] === first[1];
};

/** Each point's [in, out] handles as the smooth curve through them has them; a loop's
 * seam has both, on its first and last point alike. */
export function smoothHandles(points: Vec[]): [Vec, Vec][] {
  const pieces = curvePieces(points);
  const loop = isLoop(points);
  return points.map((point, i): [Vec, Vec] => [
    pieces[i - 1]?.[2] ?? (loop ? pieces.at(-1)?.[2] : undefined) ?? point,
    pieces[i]?.[1] ?? (loop ? pieces[0]?.[1] : undefined) ?? point,
  ]);
}

/** A curve's pieces as cubic Béziers: from, its two controls, to. */
export const curveSegments = (mark: PathMark) =>
  segmentsOf(mark.points, mark.handles);

/** A point along a cubic Bézier piece, `t` from 0 to 1. */
export const bezier = ([a, b, c, d]: [Vec, Vec, Vec, Vec], t: number): Vec => {
  const u = 1 - t;
  return [0, 1].map(
    (k) =>
      u * u * u * a[k] +
      3 * u * u * t * b[k] +
      3 * u * t * t * c[k] +
      t ** 3 * d[k]
  ) as Vec;
};

/** An upright ellipse's handles from its box: right, top, left, bottom. */
export const ellipseIn = (
  left: number,
  right: number,
  bottom: number,
  top: number
): Vec[] => {
  const [cx, cy] = [tidy((left + right) / 2), tidy((bottom + top) / 2)];
  return [
    [tidy(right), cy],
    [cx, tidy(top)],
    [tidy(left), cy],
    [cx, tidy(bottom)],
  ];
};

/** The middle of an upright ellipse, from its handles. */
export const ellipseCentre = (points: Vec[]): Vec => [
  points[1][0],
  points[0][1],
];

/** The handles after one is pulled: right or left sets the width and top or bottom the
 * height, about the middle, so it stays put on the grid. `uniform` (Shift) scales the
 * other way by as much, keeping its shape. A pull onto the middle keeps the size. */
export function pullEllipse(
  points: Vec[],
  index: number,
  to: Vec,
  uniform = false
): Vec[] {
  const [cx, cy] = ellipseCentre(points);
  let [rx, ry] = [points[0][0] - cx, points[1][1] - cy];
  if (index % 2 === 0) {
    const next = Math.abs(to[0] - cx) || rx;
    if (uniform && rx) ry *= next / rx;
    rx = next;
  } else {
    const next = Math.abs(to[1] - cy) || ry;
    if (uniform && ry) rx *= next / ry;
    ry = next;
  }
  return ellipseIn(cx - rx, cx + rx, cy - ry, cy + ry);
}

/** What a line, curve or ellipse draws through, as short straight steps. */
export function pathOf(mark: PathMark, perSegment = 16): Vec[] {
  if (mark.kind === 'curve') {
    const pieces = curveSegments(mark);
    if (!pieces.length) return mark.points;
    return [
      ...pieces.flatMap((piece) =>
        Array.from({ length: perSegment }, (_, step) =>
          bezier(piece, step / perSegment)
        )
      ),
      mark.points.at(-1) as Vec,
    ];
  }
  if (mark.kind === 'line' || mark.kind === 'vector') return mark.points;
  const [[right, cy], [cx, top]] = mark.points;
  const [rx, ry] = [right - cx, top - cy];
  const steps = perSegment * 4;
  return Array.from({ length: steps + 1 }, (_, i): Vec => {
    const turn = (i / steps) * Math.PI * 2;
    return [cx + rx * Math.cos(turn), cy + ry * Math.sin(turn)];
  });
}

/** Most marks one plane holds (the board catalog's, as every limit here). */
export const { MARKS_MAX } = BOARD_CATALOG.limits;

/** Longest formula a member can type; the renderer draws nothing past it. */
export const { LATEX_MAX } = BOARD_CATALOG.limits;

/** A bar or pie chart is a card of its own: a coordinate means nothing on either (Epo
 * 2026-11-06). The student reads the table and builds it by hand. */
export type ChartKind = 'bar' | 'pie';
export type ChartBar = {
  fill: Color;
  id: string;
  label: string;
  value: number;
};
/** A pie's label: clockwise from 12 o'clock, `reach` out from the middle as a share
 * of the radius, so it stays where it was put as the card resizes. Its `size` is as a
 * plane label's, CHART_TEXT without one. */
export type PieLabel = {
  angle: number;
  id: string;
  reach: number;
  size?: number;
  text: string;
};
/** A pie slice's fill, by the line it starts at (clockwise). */
export type SliceFill = { fill: Color; from: number };

export type ChartData = {
  axisMax: number;
  axisStep: number;
  bars: ChartBar[];
  /** Absent on a chart saved before pies had fills. */
  fills?: SliceFill[];
  kind: ChartKind;
  labels: PieLabel[];
  spokes: number[];
};

export const { AXIS_MAX, BARS_MAX, LABEL_LENGTH_MAX, LABELS_MAX, SPOKES_MAX } =
  BOARD_CATALOG.limits;

/** Text sizes in pixels: a plane label's and formula's, and a chart's text, until a
 * frame's corner sets one (Epo 2026-11-13); and the range a corner sets. */
export { FORMULA_SIZE, LABEL_SIZE } from '@/features/graph/model';
export const CHART_TEXT = 12;
export const { TEXT_SIZE_MAX, TEXT_SIZE_MIN } = BOARD_CATALOG.limits;
export const isTextSize = (size: unknown) =>
  size === undefined ||
  (typeof size === 'number' &&
    Number.isInteger(size) &&
    size >= TEXT_SIZE_MIN &&
    size <= TEXT_SIZE_MAX);

/** Room around the chart, as a card and in the editor. */
export type Pads = { bottom: number; left: number; right: number; top: number };
export const CARD_PADS: Record<ChartKind, Pads> = {
  bar: { bottom: 30, left: 36, right: 12, top: 14 },
  pie: { bottom: 14, left: 14, right: 14, top: 14 },
};

/** The marking image draws card paper opaque, as previews do, so a stroke under a card
 * stays covered there; `asImage` turns it on while the image draws. */
let imaging = false;
export const cardPaper = (scheme: 'dark' | 'light'): Paper =>
  imaging ? EXPORT_PAPER : PAPER[scheme];
export function asImage<T>(draw: () => T) {
  imaging = true;
  try {
    return draw();
  } finally {
    imaging = false;
  }
}

/** A bar's width within its slot. */
export const BAR_SHARE = 0.56;

/** Where a bar chart's bars go. `slots` is one more than the bars in the editor, so
 * there's a free place to start the next. */
export function barPlot(frame: Box, pads: Pads, slots: number) {
  const left = frame.x + pads.left;
  const top = frame.y + pads.top;
  const width = Math.max(1, frame.w - pads.left - pads.right);
  const height = Math.max(1, frame.h - pads.top - pads.bottom);
  return { base: top + height, height, left, slotW: width / slots, top, width };
}

export function pieCircle(frame: Box, pads: Pads) {
  const width = Math.max(2, frame.w - pads.left - pads.right);
  const height = Math.max(2, frame.h - pads.top - pads.bottom);
  return {
    cx: frame.x + pads.left + width / 2,
    cy: frame.y + pads.top + height / 2,
    r: Math.min(width, height) / 2,
  };
}

/** A pie's filled slices, clockwise from one line to the next (the whole round with
 * one line). A fill whose line is gone draws nothing. */
export function filledSlices({
  fills = [],
  spokes,
}: Pick<ChartData, 'fills' | 'spokes'>) {
  const sorted = [...spokes].sort((a, b) => a - b);
  return sorted.flatMap((from, i) => {
    const fill = fills.find((slice) => slice.from === from)?.fill;
    if (!fill) return [];
    const next = sorted[(i + 1) % sorted.length];
    return [{ fill, from, to: next > from ? next : next + 360 }];
  });
}

/** A clockwise angle from 12 o'clock to a point on the screen, where y goes down. */
export const onScreen = (
  cx: number,
  cy: number,
  r: number,
  degrees: number
) => {
  const turn = (degrees * Math.PI) / 180;
  return [cx + r * Math.sin(turn), cy - r * Math.cos(turn)] as const;
};
