import type { CSSProperties } from 'react';

type Edge = 'top' | 'right' | 'bottom' | 'left' | 'middleH' | 'middleV';

const EDGE_PATHS: Record<Edge, string> = {
  bottom: 'M4 20h16',
  left: 'M4 4v16',
  middleH: 'M4 12h16',
  middleV: 'M12 4v16',
  right: 'M20 4v16',
  top: 'M4 4h16',
};
const EDGES = Object.keys(EDGE_PATHS) as Edge[];

/** The edges each border command sets; the rest of the 2×2 grid stays a faint guide. */
export const BORDER_EDGES = {
  all: EDGES,
  bottom: ['bottom'],
  horizontal: ['middleH'],
  inner: ['middleH', 'middleV'],
  left: ['left'],
  none: [],
  outer: ['top', 'right', 'bottom', 'left'],
  right: ['right'],
  top: ['top'],
  vertical: ['middleV'],
} satisfies Record<string, readonly Edge[]>;

export type BorderIconKind = keyof typeof BORDER_EDGES;

/**
 * Capy's border icons, drawn by hand for the DOCX and XLSX toolbars: set edges
 * in full ink over a faint grid, instead of Hugeicons' dashed cells.
 */
export function BorderIcon({
  kind,
  size,
  style,
}: {
  kind: BorderIconKind;
  size: number;
  style?: CSSProperties;
}) {
  const set: readonly Edge[] = BORDER_EDGES[kind];
  return (
    <svg
      aria-hidden
      data-icon
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      style={{ display: 'block', flex: '0 0 auto', ...style }}
      viewBox="0 0 24 24"
      width={size}
    >
      <g opacity={0.3} strokeWidth={1.5}>
        {EDGES.filter((edge) => !set.includes(edge)).map((edge) => (
          <path d={EDGE_PATHS[edge]} key={edge} />
        ))}
      </g>
      <g strokeWidth={2}>
        {set.map((edge) => (
          <path d={EDGE_PATHS[edge]} key={edge} />
        ))}
      </g>
    </svg>
  );
}
