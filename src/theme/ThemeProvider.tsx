import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export type Style = 'classroom' | 'notion';
export type Theme = 'latte' | 'mocha';

export const STYLES: {
  value: Style;
  label: string;
  supportedThemes: Theme[];
}[] = [
  {
    label: 'Classroom',
    supportedThemes: ['latte', 'mocha'],
    value: 'classroom',
  },
  { label: 'Notion', supportedThemes: ['latte', 'mocha'], value: 'notion' },
];

export const THEMES: {
  value: Theme;
  label: string;
  displayColor: string;
  isDark: boolean;
}[] = [
  { displayColor: '#fafafa', isDark: false, label: 'Latte', value: 'latte' },
  { displayColor: '#222222', isDark: true, label: 'Mocha', value: 'mocha' },
];

interface ThemeState {
  isDark: boolean;
  setStyle: (m: Style) => void;
  setTheme: (t: Theme) => void;
  style: Style;
  theme: Theme;
}

const ThemeContext = createContext<ThemeState | null>(null);

const STYLE_KEY = 'evo.style';
const THEME_KEY = 'evo.theme';

function readStored<T extends string>(
  key: string,
  allowed: T[],
  fallback: T
): T {
  if (typeof localStorage === 'undefined') return fallback;
  const v = localStorage.getItem(key) as T | null;
  return v && allowed.includes(v) ? v : fallback;
}

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
  );
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [style, setStyleState] = useState<Style>(() =>
    readStored<Style>(
      STYLE_KEY,
      STYLES.map((s) => s.value),
      'classroom'
    )
  );
  const [theme, setThemeState] = useState<Theme>(() =>
    readStored<Theme>(
      THEME_KEY,
      THEMES.map((t) => t.value),
      prefersDark() ? 'mocha' : 'latte'
    )
  );

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.style = style;
    root.dataset.theme = theme;
    if (THEMES.find((t) => t.value === theme)?.isDark)
      root.classList.add('dark');
    else root.classList.remove('dark');
  }, [style, theme]);

  const setStyle = useCallback((t: Style) => {
    setStyleState(t);
    localStorage.setItem(STYLE_KEY, t);
  }, []);

  const setTheme = useCallback((m: Theme) => {
    setThemeState(m);
    localStorage.setItem(THEME_KEY, m);
  }, []);

  const value = useMemo(
    () => ({
      isDark: THEMES.find((t) => t.value === theme)?.isDark ?? false,
      setStyle,
      setTheme,
      style,
      theme,
    }),
    [theme, style, setTheme, setStyle]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
