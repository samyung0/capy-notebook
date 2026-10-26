import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

import type { PageFrame } from '@/api/types';
import { onSyncedCustomization } from './customizationEvents';
import { pageFrameStyle, sanitizePageFrame } from './pageFrame';
import { STYLES, type Style, THEMES, type Theme, ThemeContext } from './theme';

const STYLE_KEY = 'capy.style';
const THEME_KEY = 'capy.theme';
/** The frame's settings, and its resolved paint for the pre-paint scripts in
 * index.html and share.html (shared pages read only this, never the API). */
const FRAME_KEY = 'capy.pageFrame';
const FRAME_CSS_KEY = 'capy.pageFrameCss';

function readFrame(): PageFrame {
  try {
    return sanitizePageFrame(
      JSON.parse(localStorage.getItem(FRAME_KEY) ?? 'null')
    );
  } catch {
    return sanitizePageFrame(null);
  }
}

function readStored<T extends string>(
  key: string,
  allowed: T[],
  fallback: T
): T {
  if (typeof localStorage === 'undefined') return fallback;
  let v = localStorage.getItem(key);
  if (key === THEME_KEY && v === 'macchiato') {
    v = 'frappe';
    localStorage.setItem(key, v);
  }
  return v && allowed.includes(v as T) ? (v as T) : fallback;
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
      'capy'
    )
  );
  const [theme, setThemeState] = useState<Theme>(() =>
    readStored<Theme>(
      THEME_KEY,
      THEMES.map((t) => t.value),
      prefersDark() ? 'mocha' : 'latte'
    )
  );

  const [pageFrame, setPageFrameState] = useState<PageFrame>(readFrame);

  // Before paint: a device with nothing stored yet (the pre-paint scripts
  // drew no frame) shows the default with the shell's first frame.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const vars = pageFrameStyle(pageFrame);
    for (const name of [...root.style]) {
      if (name.startsWith('--page-frame-')) root.style.removeProperty(name);
    }
    if (vars) {
      for (const [name, value] of Object.entries(vars))
        root.style.setProperty(name, value);
      root.dataset.pageFrame = '';
      localStorage.setItem(FRAME_CSS_KEY, JSON.stringify(vars));
    } else {
      delete root.dataset.pageFrame;
      localStorage.removeItem(FRAME_CSS_KEY);
    }
  }, [pageFrame]);

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

  const setPageFrame = useCallback((frame: PageFrame) => {
    setPageFrameState(frame);
    localStorage.setItem(FRAME_KEY, JSON.stringify(frame));
  }, []);

  // A look synced from another device replaces this one's.
  useEffect(
    () =>
      onSyncedCustomization((c) => {
        const style = STYLES.find((s) => s.value === c.style)?.value;
        const theme = THEMES.find((t) => t.value === c.theme)?.value;
        if (style) setStyle(style);
        if (theme) setTheme(theme);
        setPageFrame(sanitizePageFrame(c.pageFrame));
      }),
    [setStyle, setTheme, setPageFrame]
  );

  const value = useMemo(
    () => ({
      isDark: THEMES.find((t) => t.value === theme)?.isDark ?? false,
      pageFrame,
      setPageFrame,
      setStyle,
      setTheme,
      style,
      theme,
    }),
    [theme, style, pageFrame, setTheme, setStyle, setPageFrame]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
