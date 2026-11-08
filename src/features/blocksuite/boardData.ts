import type { Box, Vec } from './boardGeometry';

/** What a saved board's cards hold, and their limits, apart from the editor: the
 * board's check and its preview read them without loading BlockSuite. */

/** A board colour, as BlockSuite's `Color` stores it. */
export type Color =
  | string
  | { normal: string }
  | { dark: string; light: string };

/** What's plotted on a plane, in its own units. A line or curve grows a click at a time,
 * each click one undo step. */
export type Mark =
  | { id: string; kind: 'dot'; at: Vec }
  | { id: string; kind: 'line' | 'curve'; points: Vec[] };

/** Most marks one plane holds. */
export const MARKS_MAX = 500;

/** Longest formula a member can type; the renderer draws nothing past it. */
export const LATEX_MAX = 2000;

/** A bar or pie chart is a card of its own: a coordinate means nothing on either (Epo
 * 2026-11-06). The student reads the table and builds it by hand. */
export type ChartKind = 'bar' | 'pie';
export type ChartBar = {
  fill: Color;
  id: string;
  label: string;
  value: number;
};
export type PieLabel = { angle: number; id: string; text: string };
/** A pie slice's fill, by the line it starts at (clockwise). */
export type SliceFill = { fill: Color; from: number };

export type ChartData = {
  axisMax: number;
  axisStep: number;
  bars: ChartBar[];
  fills: SliceFill[];
  kind: ChartKind;
  labels: PieLabel[];
  spokes: number[];
};

export const BARS_MAX = 24;
export const SPOKES_MAX = 60;
export const LABELS_MAX = 60;
export const LABEL_LENGTH_MAX = 24;
export const AXIS_MAX = 1e9;

/** Room around the chart, as a card and in the editor. */
export type Pads = { bottom: number; left: number; right: number; top: number };
export const CARD_PADS: Record<ChartKind, Pads> = {
  bar: { bottom: 30, left: 36, right: 12, top: 14 },
  pie: { bottom: 14, left: 14, right: 14, top: 14 },
};

export const INK = '#000';
export const TEXT = '#1d1d1f';
export const NUMBER = '#55555b';

/** A plane or chart card's colours, with the board's light or dark: paper, grid,
 * axes and ink. Dark paper is a dark note's. The marking image is always light. */
export type Paper = {
  axis: string;
  edge: string;
  ink: string;
  major: string;
  minor: string;
  number: string;
  paper: string;
  rule: string;
  text: string;
};
export const PAPER: Record<'dark' | 'light', Paper> = {
  dark: {
    axis: '#9a9a9a',
    edge: '#3a3a3a',
    ink: '#fff',
    major: '#3a3a3a',
    minor: '#2e2e2e',
    number: '#a6a6ab',
    paper: '#252525',
    rule: '#363636',
    text: '#eaeaea',
  },
  light: {
    axis: '#6f6f6c',
    edge: '#d9d9d6',
    ink: INK,
    major: '#dededb',
    minor: '#f1f1ef',
    number: NUMBER,
    paper: '#fff',
    rule: '#e4e4e2',
    text: TEXT,
  },
};

/** On the board a card's paper is half see-through, so the panel's frost over the
 * page frame shows (Epo 2026-11-08); open for editing it's solid. */
export const CARD_PAPER: Record<'dark' | 'light', Paper> = {
  dark: { ...PAPER.dark, paper: 'rgba(37, 37, 37, 0.5)' },
  light: { ...PAPER.light, paper: 'rgba(255, 255, 255, 0.5)' },
};

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
  fills,
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
