import type { CSSProperties } from 'react';

/**
 * Evo Notes line-icon set. Lucide-style geometry: 24×24 grid, 1.8 stroke,
 * round caps & joins, currentColor stroke. Self-contained (no CDN).
 */
const PATHS = {
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
  bell: ['M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z', 'M10 20a2 2 0 004 0'],
  book: [
    'M12 7v14',
    'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
  ],
  chart: [
    'M3 3v16a2 2 0 0 0 2 2h16',
    'M16 5h2s1 0 1 1v10s0 1 -1 1h-2s-1 0 -1 -1v-10s0 -1 1 -1',
    'M8 8h2s1 0 1 1v7s0 1 -1 1h-2s-1 0 -1 -1v-7s0 -1 1 -1',
  ],
  check: ['M5 12.5l4.5 4.5L19 6.5'],
  chevronDown: ['M6 9l6 6 6-6'],
  chevronLeft: ['M15 6l-6 6 6 6'],
  chevronRight: ['M9 6l6 6-6 6'],
  chevronUp: ['M6 15l6-6 6 6'],
  clock: ['M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17z', 'M12 7.5V12l3 2'],
  collapseFolder: [
    'M10 8h10s2 0 2 2v10s0 2 -2 2h-10s-2 0 -2 -2v-10s0 -2 2 -2',
    'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
    'M12 15 L18 15',
  ],
  dashboard: [
    'M3 3h7.5v7.5H3z',
    'M13.5 3H21v7.5h-7.5z',
    'M13.5 13.5H21V21h-7.5z',
    'M3 13.5h7.5V21H3z',
  ],
  error: [
    'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0',
    'M12 8L12 12',
    'M12 16 L12.01 16',
  ],
  eye: [
    'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0',
    'M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
  ],
  fileError: [
    'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
    'M12 9v4',
    'M12 17h.01',
  ],
  files: [
    'M13.5 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8.5z',
    'M13.5 3v5.5H19',
  ],
  filter: ['M3 5h18', 'M6 12h12', 'M10 19h4'],
  flashcards: [
    'M5 7h11a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2z',
    'M8 4h11a2 2 0 012 2v8',
  ],
  globe: [
    'M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17z',
    'M3.5 12h17',
    'M12 3.5c2.5 2.4 2.5 14.1 0 17',
    'M12 3.5c-2.5 2.4-2.5 14.1 0 17',
  ],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  help: [
    'M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17z',
    'M9.5 9.5a2.5 2.5 0 114 2c-.8.6-1.5 1.1-1.5 2',
    'M12 17h.01',
  ],
  link: [
    'M9 14a3 3 0 004.2 0l3-3a3 3 0 10-4.2-4.2L10.5 8',
    'M15 10a3 3 0 00-4.2 0l-3 3A3 3 0 1012 17.2l1.5-1.2',
  ],
  list: [
    'M8 6h13',
    'M8 12h13',
    'M8 18h13',
    'M3.5 6h.01',
    'M3.5 12h.01',
    'M3.5 18h.01',
  ],
  location: [
    'M12 21.5s7-5.7 7-11.2a7 7 0 10-14 0c0 5.5 7 11.2 7 11.2z',
    'M12 7.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
  ],
  lock: [
    'M6 11h12a1 1 0 011 1v7a1 1 0 01-1 1H6a1 1 0 01-1-1v-7a1 1 0 011-1z',
    'M8 11V8a4 4 0 018 0v3',
  ],
  logout: [
    'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4',
    'M16 17l5-5-5-5',
    'M21 12H9',
  ],
  maximize: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  message: ['M21 12a8 8 0 01-11.3 7.3L4 21l1.7-5.7A8 8 0 1121 12z'],
  microphone: [
    'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3z',
    'M5 11a7 7 0 0014 0',
    'M12 18v3',
    'M8.5 21h7',
  ],
  minimize: ['M4 14h6v6', 'M14 4h6v6', 'M14 10l7-7', 'M3 21l7-7'],
  minus: ['M5 12h14'],
  moon: ['M20 14.5A8 8 0 119.5 4a6.5 6.5 0 0010.5 10.5z'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  moreVertical: ['M12 5h.01', 'M12 12h.01', 'M12 19h.01'],
  palette: [
    'M12 3.5a8.5 8.5 0 00-.5 17c1 0 1.5-.8 1.5-1.6 0-1.2-1-1.6-1-2.6 0-.8.7-1.3 1.5-1.3H15a5 5 0 005-5C20 6.5 16.4 3.5 12 3.5z',
    'M7.5 12.5h.01',
    'M9.5 8.5h.01',
    'M14 8h.01',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  practice: [
    'M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17z',
    'M12 8a4 4 0 100 8 4 4 0 000-8z',
    'M12 11.4a.6.6 0 100 1.2.6.6 0 000-1.2z',
  ],
  profile: [
    'M12 4.2a3.8 3.8 0 100 7.6 3.8 3.8 0 000-7.6z',
    'M5.5 20.5a6.5 6.5 0 0113 0',
  ],
  quiz: [
    'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3',
    'M12 17h.01',
    'M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17z',
  ],
  rubber: [
    'M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21',
    'm5.082 11.09 8.828 8.828',
  ],
  schedule: [
    'M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z',
    'M3 10h18',
    'M8 3v4',
    'M16 3v4',
  ],
  search: ['M11 4a7 7 0 100 14 7 7 0 000-14z', 'M21 21l-4-4'],
  send: ['M5 12h14', 'M13 6l6 6-6 6'],
  settings: [
    'M4 7.5h8',
    'M16 7.5h4',
    'M14 5.5a2 2 0 100 4 2 2 0 000-4z',
    'M4 16.5h4',
    'M12 16.5h8',
    'M10 14.5a2 2 0 100 4 2 2 0 000-4z',
  ],
  sparkles: [
    'M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z',
    'M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z',
  ],
  sun: [
    'M12 7a5 5 0 100 10 5 5 0 000-10z',
    'M12 2v2',
    'M12 20v2',
    'M4 12H2',
    'M22 12h-2',
    'M5 5l1.5 1.5',
    'M17.5 17.5L19 19',
    'M19 5l-1.5 1.5',
    'M6.5 17.5L5 19',
  ],
  tasks: ['M4 4h16v16H4z', 'M8.5 12.3l2.4 2.4 4.6-5'],
  trash: [
    'M4 7h16',
    'M10 11v6',
    'M14 11v6',
    'M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13',
    'M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3',
  ],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M5 20h14'],
  warning: [
    'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    'M12 9v4',
    'M12 17h.01',
  ],
  workspaces: [
    'M12 3l9 4.5-9 4.5-9-4.5z',
    'M3 12l9 4.5 9-4.5',
    'M3 16.5l9 4.5 9-4.5',
  ],
  write: ['M12 20h9', 'M16.5 3.5a2.05 2.05 0 113 3L7 19l-4 1 1-4z'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  zoomIn: [
    'M11 4a7 7 0 100 14 7 7 0 000-14z',
    'M21 21l-4-4',
    'M11 8v6',
    'M8 11h6',
  ],
  zoomOut: ['M11 4a7 7 0 100 14 7 7 0 000-14z', 'M21 21l-4-4', 'M8 11h6'],
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps {
  className?: string;
  name: IconName;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.8,
  className,
  style,
}: IconProps) {
  const ds = PATHS[name] ?? PATHS.dashboard;
  return (
    <svg
      aria-hidden
      className={className}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      style={{ display: 'block', flex: '0 0 auto', ...style }}
      viewBox="0 0 24 24"
      width={size}
    >
      {ds.map((d, i) => (
        <path d={d} key={i} />
      ))}
    </svg>
  );
}
