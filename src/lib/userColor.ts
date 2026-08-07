import type { UserColor } from '@/api/types';

/** Resolves a workspace/label color to themed CSS-var pairs (bg + fg + solid). */
export interface ColorPair {
  bg: string;
  fg: string;
  hoverBg?: string;
}

const USER_COLOR_MAP: Record<UserColor, ColorPair> = {
  amber: {
    bg: 'var(--usercolor-tint-amber)',
    fg: 'var(--usercolor-tint-amber-fg)',
  },
  blue: {
    bg: 'var(--usercolor-tint-blue)',
    fg: 'var(--usercolor-tint-blue-fg)',
  },
  coral: {
    bg: 'var(--usercolor-tint-coral)',
    fg: 'var(--usercolor-tint-coral-fg)',
  },
  graphite: {
    bg: 'var(--usercolor-tint-graphite)',
    fg: 'var(--usercolor-tint-graphite-fg)',
  },
  green: {
    bg: 'var(--usercolor-tint-green)',
    fg: 'var(--usercolor-tint-green-fg)',
  },
  purple: {
    bg: 'var(--usercolor-tint-purple)',
    fg: 'var(--usercolor-tint-purple-fg)',
  },
  transparent: {
    bg: 'transparent',
    fg: 'var(--color-fg)',
  },
};

const USER_COLOR_MAP_DARK: Record<UserColor, ColorPair> = {
  amber: {
    bg: 'var(--usercolor-tint-amber-dark)',
    fg: 'var(--usercolor-tint-amber-dark-fg)',
  },
  blue: {
    bg: 'var(--usercolor-tint-blue-dark)',
    fg: 'var(--usercolor-tint-blue-dark-fg)',
  },
  coral: {
    bg: 'var(--usercolor-tint-coral-dark)',
    fg: 'var(--usercolor-tint-coral-dark-fg)',
  },
  graphite: {
    bg: 'var(--usercolor-tint-graphite-dark)',
    fg: 'var(--usercolor-tint-graphite-dark-fg)',
  },
  green: {
    bg: 'var(--usercolor-tint-green-dark)',
    fg: 'var(--usercolor-tint-green-dark-fg)',
  },
  purple: {
    bg: 'var(--usercolor-tint-purple-dark)',
    fg: 'var(--usercolor-tint-purple-dark-fg)',
  },
  transparent: {
    // user purple for transparent? may need to adjust in future for other themes
    bg: 'var(--usercolor-tint-purple-dark)',
    fg: 'var(--usercolor-tint-purple-dark-fg)',
  },
};

export const DEFAULT_USER_COLOR = USER_COLOR_MAP['transparent'];

export const DEFAULT_USER_COLOR_DARK = USER_COLOR_MAP_DARK['transparent'];

export const userColorPair = (c?: UserColor): ColorPair =>
  c ? (USER_COLOR_MAP[c] ?? DEFAULT_USER_COLOR) : DEFAULT_USER_COLOR;

export const userColorPairDark = (c?: UserColor): ColorPair =>
  c
    ? (USER_COLOR_MAP_DARK[c] ?? DEFAULT_USER_COLOR_DARK)
    : DEFAULT_USER_COLOR_DARK;

export const USER_COLORS: UserColor[] = [
  'green',
  'purple',
  'blue',
  'amber',
  'coral',
  'graphite',
  'transparent',
];

export const USER_COLORS_DISPLAY: Record<UserColor, string> = {
  amber: 'Amber',
  blue: 'Blue',
  coral: 'Coral',
  graphite: 'Graphite',
  green: 'Green',
  purple: 'Purple',
  transparent: 'Transparent',
};
