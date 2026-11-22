import { BOARD_CATALOG } from '@/api/board.generated';
import { EXPORT_PAPER, PAPER, type Paper } from '@/features/graph/paper';
import type { Box } from './boardGeometry';

export { INK, NUMBER, PAPER, type Paper, TEXT } from '@/features/graph/paper';

/** What a saved board's cards hold, and their limits, apart from the editor: the
 * board's check and its preview read them without loading BlockSuite. */

/** A board colour, as BlockSuite's `Color` stores it. */
export type Color =
  | string
  | { normal: string }
  | { dark: string; light: string };
const isText = (value: unknown) => typeof value === 'string';
/** Whether a stored value is a board colour, as BlockSuite's `ColorSchema` takes it. */
export const isColour = (value: unknown) => {
  if (isText(value)) return true;
  if (!value || typeof value !== 'object') return false;
  const { dark, light, normal } = value as Record<string, unknown>;
  return isText(normal) || (isText(dark) && isText(light));
};

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
/** A pie's line, clockwise from 12 o'clock, with the fill of the slice that starts
 * at it (clockwise to the next line): erasing the line takes its fill along. */
export type PieSpoke = { angle: number; fill?: Color; id: string };

/** A chart as it's drawn: its bars, pie labels and pie lines in order. The card
 * holds each list keyed by id (Epo 2026-11-22, as the plane's elements), so two
 * people changing different items both keep their change. */
export type ChartData = {
  axisMax: number;
  axisStep: number;
  bars: ChartBar[];
  kind: ChartKind;
  labels: PieLabel[];
  spokes: PieSpoke[];
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

/** The places across a bar chart in the editor, at least three: one per bar and,
 * under the cap, a free place after the last to start the next. A chart merged past
 * the cap has a place per bar and none free. */
export const barSlots = (count: number) =>
  Math.max(3, count < BARS_MAX ? count + 1 : count);
/** Whether a press in the editor's place `slot` sets a bar: one of the `count` bars,
 * or the free place after the last while under the cap. */
export const setsBar = (slot: number, count: number) =>
  slot < count || (slot === count && count < BARS_MAX);

/** Where a bar chart's bars go. `slots` is one more than the bars in the editor
 * (`barSlots`), so there's a free place to start the next. */
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

/** A pie's slices clockwise from its lines: each from a line to the next (the whole
 * round with one line), in degrees. */
export type Slice = { from: number; size: number; spoke: PieSpoke };
export function slicesOf(spokes: PieSpoke[]): Slice[] {
  const sorted = [...spokes].sort((a, b) => a.angle - b.angle);
  return sorted.map((spoke, i) => ({
    from: spoke.angle,
    size:
      (i + 1 < sorted.length ? sorted[i + 1].angle : sorted[0].angle + 360) -
      spoke.angle,
    spoke,
  }));
}

/** A pie's filled slices, each from its line to the next, clockwise. */
export function filledSlices(spokes: PieSpoke[]) {
  return slicesOf(spokes).flatMap(({ from, size, spoke: { fill } }) =>
    fill ? [{ fill, from, to: from + size }] : []
  );
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
