import type { CSSProperties } from 'react';
import sprite from '@/assets/catppuccin.svg?no-inline';
import type { FileIconName } from '@/lib/fileIcons';

export type { FileIconName } from '@/lib/fileIcons';

/** Colored Catppuccin file/material glyph. The sprite's paths are stroke-only
 * and inherit `strokeWidth` and the `--ctp-*` palette from the page. */
export function FileIcon({
  name,
  strokeWidth = 1.3,
  className,
  style,
}: {
  name: FileIconName;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden
      className={className}
      strokeWidth={strokeWidth}
      style={{ display: 'block', flex: '0 0 auto', ...style }}
      viewBox="0 0 16 16"
    >
      <use href={`${sprite}#${name}`} />
    </svg>
  );
}
