import { createContext, useContext } from 'react';
import type { FrostPanel, PageFrame } from '@/api/types';

export type Style = 'capy' | 'fisheye' | 'notion';
export type Theme = 'latte' | 'mocha' | 'frappe';

export const STYLES: {
  value: Style;
  label: string;
  supportedThemes: Theme[];
}[] = [
  {
    label: 'Capy',
    supportedThemes: ['latte', 'frappe', 'mocha'],
    value: 'capy',
  },
  {
    label: 'Fisheye',
    supportedThemes: ['latte', 'frappe', 'mocha'],
    value: 'fisheye',
  },
  {
    label: 'Notion',
    supportedThemes: ['latte', 'frappe', 'mocha'],
    value: 'notion',
  },
];

export const THEMES: {
  value: Theme;
  label: string;
  isDark: boolean;
}[] = [
  { isDark: false, label: 'Latte', value: 'latte' },
  { isDark: true, label: 'Frappé', value: 'frappe' },
  { isDark: true, label: 'Mocha', value: 'mocha' },
];

/** Swatch colour per style/theme, taken from its tokens: the slate card tone
 * (`--surface-card-dark-bg`) for Frappé and the page (`--surface-page`) for
 * Mocha, the colours each reads as, so the two stay apart at swatch size. */
const SWATCH_COLORS: Record<Style, Record<Theme, string>> = {
  capy: { frappe: '#2f3e52', latte: '#f7f7f7', mocha: '#0d1219' },
  fisheye: { frappe: '#2f3e52', latte: '#f7f7f7', mocha: '#0d1219' },
  notion: { frappe: '#303034', latte: '#f7f7f5', mocha: '#171717' },
};

export function themeSwatch(style: Style, theme: Theme): string {
  return SWATCH_COLORS[style][theme];
}

interface ThemeState {
  isDark: boolean;
  /** The painted page frame (pageFrame.ts); kept on this device. */
  pageFrame: PageFrame;
  setPageFrame: (frame: PageFrame) => void;
  setStyle: (m: Style) => void;
  setTheme: (t: Theme) => void;
  style: Style;
  theme: Theme;
}

export const ThemeContext = createContext<ThemeState | null>(null);

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

/** Whether `panel` frosts over the page frame (`data-frosted`); the
 * stylesheet only draws it while a frame is shown. Shared pages and tests
 * render panels without a ThemeProvider, and have no frame to frost over. */
/** Inside a panel frosted over the page frame. Popups portal out of the
 * panel, out of reach of the stylesheet's `[data-frosted]`, so floating
 * toolbars read this instead; dialogs reset it, being opaque. */
export const FrostedSurface = createContext(false);

export function useFrosted(panel: FrostPanel | undefined): boolean {
  const frosted = useContext(ThemeContext)?.pageFrame.frosted;
  return !!panel && !!frosted?.includes(panel);
}
