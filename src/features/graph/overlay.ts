/* What an editor draws over a graph or chart while it is edited: the value chip
 * beside the pointer and the frame of a picked label or formula. Shared by the
 * canvas plane's and chart's editors and the question graph editor. */
import type { Vec } from './model';

/** A text's box on screen: a plane label or formula, or a pie label. */
export type TextBox = { h: number; w: number; x: number; y: number };

/** The one picked label or formula wears the board's selection frame (Epo 2026-11-13,
 * "the same purple box outline"): a 1px accent line 6px out from its text, a 9px
 * square on each corner, as vendor local change 56 draws a card's. A corner's drag
 * sizes the text about its middle, which stays put. */
const OUT = 6;
const SQUARE = 9;
const GRAB = 10;

/** The frame's corners, clockwise from the top left. */
const cornersOf = ({ h, w, x, y }: TextBox): Vec[] => [
  [x - OUT, y - OUT],
  [x + w + OUT, y - OUT],
  [x + w + OUT, y + h + OUT],
  [x - OUT, y + h + OUT],
];

export function drawTextFrame(
  ctx: CanvasRenderingContext2D,
  box: TextBox,
  accent: string,
  fill: string
) {
  const [[left, top], , [right, bottom]] = cornersOf(box);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = accent;
  // On the half pixel, so the 1px line stays crisp.
  const crisp = (n: number) => Math.round(n) + 0.5;
  ctx.strokeRect(
    crisp(left),
    crisp(top),
    Math.round(right - left),
    Math.round(bottom - top)
  );
  ctx.fillStyle = fill;
  for (const [x, y] of cornersOf(box)) {
    ctx.beginPath();
    ctx.roundRect(
      crisp(x - SQUARE / 2),
      crisp(y - SQUARE / 2),
      SQUARE - 1,
      SQUARE - 1,
      2.5
    );
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** The frame's corner under a pixel, if any: never on the text itself, which a press
 * moves, however small it is. */
export const frameCornerAt = (box: TextBox, [px, py]: Vec) => {
  const onText =
    px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
  if (onText) return null;
  const corner = cornersOf(box).findIndex(
    ([x, y]) => Math.abs(px - x) <= GRAB && Math.abs(py - y) <= GRAB
  );
  return corner < 0 ? null : corner;
};

/** The cursor over each corner, clockwise from the top left. */
export const CORNER_CURSOR = [
  'nwse-resize',
  'nesw-resize',
  'nwse-resize',
  'nesw-resize',
] as const;

/** The size a corner dragged from `from` to `to` gives text of `size` round `middle`:
 * as much bigger as the corner went further out, a whole pixel within `[min, max]`,
 * the bounds of what holds it. */
export function draggedSize(
  size: number,
  middle: Vec,
  from: Vec,
  to: Vec,
  [min, max]: [number, number]
) {
  const before = Math.hypot(from[0] - middle[0], from[1] - middle[1]);
  const after = Math.hypot(to[0] - middle[0], to[1] - middle[1]);
  const scaled = before ? (size * after) / before : size;
  return Math.round(Math.min(max, Math.max(min, scaled)));
}

/** The dark value chip beside the pointer, kept inside `width`. */
export function drawChip(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number
) {
  ctx.font = '13px Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const textWidth = ctx.measureText(text).width + 14;
  const chipX = Math.min(width - textWidth - 4, x + 10);
  const chipY = Math.max(4, y - 30);
  ctx.fillStyle = '#111';
  ctx.fillRect(chipX, chipY, textWidth, 22);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, chipX + 7, chipY + 11);
}
