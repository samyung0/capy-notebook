import { BOARD_CATALOG } from '@/api/board.generated';
import { EXPORT_PAPER, PAPER, type Paper } from '@/features/graph/paper';
import type { Box } from './boardGeometry';

export { functionRuns, markFunction } from '@/features/graph/curves';
export { INK, NUMBER, PAPER, type Paper, TEXT } from '@/features/graph/paper';

/** What a saved board's cards hold, and their limits, apart from the editor: the
 * board's check and its preview read them without loading BlockSuite. */

/** A board colour, as BlockSuite's `Color` stores it. */
export type Color =
  | string
  | { normal: string }
  | { dark: string; light: string };

/** Most elements one plane holds, a label's length and a curve's points: every
 * graph's (Epo 2026-11-16, D7), the question bounds. */
export {
  QUESTION_GRAPH_ELEMENTS_MAX as ELEMENTS_MAX,
  QUESTION_GRAPH_LABEL_MAX as PLANE_LABEL_MAX,
  QUESTION_GRAPH_PATH_MAX as PATH_MAX,
} from '@/api/limits.generated';

/** Longest formula a member can type, as a card or on a plane; the renderer draws
 * nothing past it. */
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
