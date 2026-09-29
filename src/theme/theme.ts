import { createContext, useContext } from 'react';

export type Style = 'classroom' | 'notion';
export type Theme = 'latte' | 'mocha' | 'macchiato';

export const STYLES: {
  value: Style;
  label: string;
  supportedThemes: Theme[];
}[] = [
  {
    label: 'Classroom',
    supportedThemes: ['latte', 'macchiato', 'mocha'],
    value: 'classroom',
  },
  {
    label: 'Notion',
    supportedThemes: ['latte', 'macchiato', 'mocha'],
    value: 'notion',
  },
];

export const THEMES: {
  value: Theme;
  label: string;
  displayColor: string;
  isDark: boolean;
}[] = [
  { displayColor: '#f7f7f7', isDark: false, label: 'Latte', value: 'latte' },
  {
    displayColor: '#24273a',
    isDark: true,
    label: 'Macchi',
    value: 'macchiato',
  },
  { displayColor: '#1e1e2e', isDark: true, label: 'Mocha', value: 'mocha' },
];

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
