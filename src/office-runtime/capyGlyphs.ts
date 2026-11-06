import type { Glyph, SwatchGlyph } from './TablerIcon';
import { ballpen, bucket, highlight, textColor } from './tablerGlyphs';

/**
 * Capy's own drawings on Tabler's grid, where Tabler has no fit (Q602): a
 * table whose middle row is one cell, that row divided again, and ".0" and
 * ".00" with an arrow.
 */
export const tableCellsMerge: Glyph = [
  'M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z',
  'M3 8h18',
  'M3 16h18',
  'M12 3v5',
  'M12 16v5',
];
export const tableCellsSplit: Glyph = [
  'M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z',
  'M3 8h18',
  'M3 16h18',
  'M12 8v8',
];
export const decimalDecrease: Glyph = [
  'M5 11h.01',
  'M12 3a2 2 0 0 1 2 2v4a2 2 0 1 1 -4 0v-4a2 2 0 0 1 2 -2',
  'M20 18h-12',
  'M11 15l-3 3l3 3',
];
export const decimalIncrease: Glyph = [
  'M3 11h.01',
  'M9 3a2 2 0 0 1 2 2v4a2 2 0 1 1 -4 0v-4a2 2 0 0 1 2 -2',
  'M17 3a2 2 0 0 1 2 2v4a2 2 0 1 1 -4 0v-4a2 2 0 0 1 2 -2',
  'M4 18h16',
  'M17 15l3 3l-3 3',
];

/** The box above the swatch bar, in grid units: glyph ink ends 1 px over it. */
const SWATCH_BOX = { bottom: 14.9, left: 3, right: 21, top: 4 };

/**
 * Colour buttons draw one bar, the swatch: the glyph loses its own baseline or
 * ink wedge and grows into that space, centred above the bar (round 3c).
 * `bounds` is the kept paths' x0 y0 x1 y1.
 */
function swatchGlyph(
  paths: Glyph,
  [x0, y0, x1, y1]: readonly [number, number, number, number],
  top = SWATCH_BOX.top
): SwatchGlyph {
  const box = SWATCH_BOX;
  const scale = Math.min(
    (box.right - box.left) / (x1 - x0),
    (box.bottom - top) / (y1 - y0)
  );
  const dx = (box.left + box.right) / 2 - ((x0 + x1) / 2) * scale;
  const dy = (top + box.bottom) / 2 - ((y0 + y1) / 2) * scale;
  return {
    paths,
    transform: `translate(${dx.toFixed(3)} ${dy.toFixed(3)}) scale(${scale.toFixed(4)})`,
  };
}

export const textColorSwatch = swatchGlyph(
  textColor.slice(0, 2),
  [9, 5, 15, 15]
);
export const highlightSwatch = swatchGlyph(
  highlight.filter((_, index) => index !== 3),
  [3, 3.2, 19.8, 19],
  3
);
export const fillSwatch = swatchGlyph(bucket, [4, 3, 20, 21]);
export const borderColorSwatch = swatchGlyph(ballpen, [4, 3, 21, 20], 3);
