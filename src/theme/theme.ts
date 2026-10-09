import { createContext, useContext } from 'react';

export type Style = 'classroom' | 'notion';
export type Theme = 'latte' | 'mocha' | 'frappe';

export const STYLES: {
  value: Style;
  label: string;
  supportedThemes: Theme[];
}[] = [
  {
    label: 'Classroom',
    supportedThemes: ['latte', 'frappe', 'mocha'],
    value: 'classroom',
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
  classroom: { frappe: '#2f3e52', latte: '#f7f7f7', mocha: '#0d1219' },
  notion: { frappe: '#303034', latte: '#f7f7f5', mocha: '#171717' },
};

export function themeSwatch(style: Style, theme: Theme): string {
  return SWATCH_COLORS[style][theme];
}

interface ThemeState {
  isDark: boolean;
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
