import type { CSSProperties } from 'react';
import {
  ballpen,
  bucket,
  chevronDown,
  chevronUp,
  highlight,
  textColor,
} from './tablerGlyphs';

/** A glyph's stroked paths on Tabler's 24 unit grid (! also fills one). */
export type Glyph = readonly string[];

/** A colour button's glyph, fitted over the swatch bar its picker draws. */
interface SwatchGlyph {
  paths: Glyph;
  transform: string;
}

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

/** An even 1.5px line at every size (Q603), so the width is whole device
 * pixels at the sizes Office uses; chevrons stay lighter, as Office's. */
const PIXEL_STROKE = 36;
const CHEVRON_STROKE = 1.8;

/** One Tabler glyph, or one of Capy's on its grid. */
export function TablerIcon({
  className,
  glyph,
  size = 18,
  style,
}: {
  className?: string;
  glyph: Glyph | SwatchGlyph;
  size?: number;
  style?: CSSProperties;
}) {
  const fitted = 'transform' in glyph;
  const paths: Glyph = fitted ? glyph.paths : glyph;
  const drawn = paths.map((d) => (
    <path
      d={d.replace('!', '')}
      fill={d.startsWith('!') ? 'currentColor' : undefined}
      key={d}
      vectorEffect={fitted ? 'non-scaling-stroke' : undefined}
    />
  ));
  return (
    <svg
      aria-hidden
      className={className}
      data-icon
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={
        fitted
          ? 1.5
          : glyph === chevronDown || glyph === chevronUp
            ? CHEVRON_STROKE
            : PIXEL_STROKE / size
      }
      style={{ display: 'block', flex: '0 0 auto', ...style }}
      viewBox="0 0 24 24"
      width={size}
    >
      {fitted ? <g transform={glyph.transform}>{drawn}</g> : drawn}
    </svg>
  );
}
