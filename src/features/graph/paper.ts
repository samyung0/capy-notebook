/** A graph's colours, with the app's light or dark: paper, grid, axes and ink.
 * Dark paper is a dark note's. On screen the paper is half see-through, so the
 * panel's frost shows (Epo 2026-11-08); exports and the marking image are
 * always light, their paper opaque (`EXPORT_PAPER`). */
export type Paper = {
  axis: string;
  /** Dark paper: black ink drawn from elsewhere (a formula) is turned light. */
  dark: boolean;
  edge: string;
  ink: string;
  major: string;
  minor: string;
  number: string;
  paper: string;
  rule: string;
  text: string;
};

export const INK = '#000';
export const TEXT = '#1d1d1f';
export const NUMBER = '#55555b';

export const PAPER: Record<'dark' | 'light', Paper> = {
  dark: {
    axis: '#9a9a9a',
    dark: true,
    edge: '#3a3a3a',
    ink: '#fff',
    major: '#3a3a3a',
    minor: '#2e2e2e',
    number: '#a6a6ab',
    paper: 'rgba(37, 37, 37, 0.5)',
    rule: '#363636',
    text: '#eaeaea',
  },
  light: {
    axis: '#6f6f6c',
    dark: false,
    edge: '#d9d9d6',
    ink: INK,
    major: '#dededb',
    minor: '#f1f1ef',
    number: NUMBER,
    paper: 'rgba(255, 255, 255, 0.5)',
    rule: '#e4e4e2',
    text: TEXT,
  },
};

export const EXPORT_PAPER: Paper = { ...PAPER.light, paper: '#fff' };
