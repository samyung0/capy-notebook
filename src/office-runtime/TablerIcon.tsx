import type { CSSProperties } from 'react';
import { chevronDown, chevronUp } from './tablerHeaderGlyphs';

/** A glyph's stroked paths on Tabler's 24 unit grid (! also fills one). */
export type Glyph = readonly string[];

/** A colour button's glyph, fitted over the swatch bar its picker draws. */
export interface SwatchGlyph {
  paths: Glyph;
  transform: string;
}

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
