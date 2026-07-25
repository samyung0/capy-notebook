import type { UserColor } from '@/api/types';

/** Resolves a workspace/label color to themed CSS-var pairs (bg + fg + solid). */
export interface ColorPair {
  bg: string;
  fg: string;
  hoverBg?: string;
}

const USER_COLOR_MAP: Record<UserColor, ColorPair> = {
  amber: {
    bg: 'var(--color-solid-amber)',
    fg: 'var(--color-solid-amber-fg)',
  },
  blue: {
    bg: 'var(--color-solid-blue)',
    fg: 'var(--color-solid-blue-fg)',
  },
  coral: {
    bg: 'var(--color-solid-coral)',
    fg: 'var(--color-solid-coral-fg)',
  },
  graphite: {
    bg: 'var(--color-solid-graphite)',
    fg: 'var(--color-solid-graphite-fg)',
  },
  green: {
    bg: 'var(--color-solid-green)',
    fg: 'var(--color-solid-green-fg)',
  },
  purple: {
    bg: 'var(--color-solid-purple)',
    fg: 'var(--color-solid-purple-fg)',
  },
  transparent: {
    bg: 'transparent',
    fg: 'var(--color-fg)',
  },
};

// TODO: separate system vs user colors
// TODO: convert all hex values to rgb/hsl so  no need for color mix
const USER_COLOR_MAP_LIGHT: Record<UserColor, ColorPair> = {
  amber: {
    bg: 'var(--color-tint-warning)',
    fg: 'var(--color-tint-warning-fg)',
    hoverBg: 'color-mix(in srgb, var(--color-solid-warning) 30%, transparent)',
  },
  blue: {
    bg: 'var(--color-tint-info)',
    fg: 'var(--color-tint-info-fg)',
    hoverBg: 'color-mix(in srgb, var(--color-solid-info) 30%, transparent)',
  },
  coral: {
    bg: 'var(--color-tint-error)',
    fg: 'var(--color-tint-error-fg)',
    hoverBg: 'color-mix(in srgb, var(--color-solid-error) 30%, transparent)',
  },
  graphite: {
    bg: 'var(--color-action)',
    fg: 'var(--color-action-fg)',
    hoverBg: 'var(--color-action)',
  },
  green: {
    bg: 'var(--color-tint-accent-2)',
    fg: 'var(--color-tint-accent-2-fg)',
    hoverBg: 'color-mix(in srgb, var(--color-solid-accent-2) 30%, transparent)',
  },
  purple: {
    bg: 'var(--color-tint-accent-1)',
    fg: 'var(--color-tint-accent-1-fg)',
    hoverBg: 'color-mix(in srgb, var(--color-solid-accent-2) 30%, transparent)',
  },
  transparent: {
    bg: 'var(--color-tint-accent-1)',
    fg: 'var(--color-tint-accent-1-fg)',
    hoverBg: 'color-mix(in srgb, var(--color-solid-accent-1) 30%, transparent)',
  },
};

export const DEFAULT_USER_COLOR = USER_COLOR_MAP['transparent'];

export const DEFAULT_USER_COLOR_LIGHT = USER_COLOR_MAP_LIGHT['transparent'];

export const userColorPair = (c?: UserColor): ColorPair =>
  c ? (USER_COLOR_MAP[c] ?? DEFAULT_USER_COLOR) : DEFAULT_USER_COLOR;

export const userColorPairLight = (c?: UserColor): ColorPair =>
  c
    ? (USER_COLOR_MAP_LIGHT[c] ?? DEFAULT_USER_COLOR_LIGHT)
    : DEFAULT_USER_COLOR_LIGHT;

export const USER_COLORS: UserColor[] = [
  'green',
  'purple',
  'blue',
  'amber',
  'coral',
  'graphite',
  'transparent',
];
