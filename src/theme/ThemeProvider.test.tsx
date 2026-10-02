import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from './ThemeProvider';
import { useTheme } from './theme';

const INITIAL_THEME_SCRIPT =
  /<script blocking="render" type="module">([\s\S]*?)<\/script>/;

afterEach(() => vi.unstubAllGlobals());

function CurrentTheme() {
  const { theme, isDark } = useTheme();
  return <span>{`${theme}:${isDark}`}</span>;
}

it.each(['macchiato', 'frappe'])(
  'keeps saved %s dark before and after React loads',
  (saved) => {
    const values = new Map([['capy.theme', saved]]);
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const root = {
      classList: { add: vi.fn() },
      dataset: {} as Record<string, string>,
    };
    const html = readFileSync('index.html', 'utf8');
    const script = html.match(INITIAL_THEME_SCRIPT)?.[1];
    expect(script).toBeDefined();
    runInNewContext(script!, {
      document: { documentElement: root },
      localStorage,
      matchMedia: () => ({ matches: false }),
    });
    expect(root.dataset.theme).toBe('frappe');
    expect(root.classList.add).toHaveBeenCalledWith('dark');
    expect(values.get('capy.theme')).toBe('frappe');

    // The provider also handles entry points without the app's initial script.
    values.set('capy.theme', saved);
    vi.stubGlobal('localStorage', localStorage);
    expect(
      renderToStaticMarkup(
        <ThemeProvider>
          <CurrentTheme />
        </ThemeProvider>
      )
    ).toContain('frappe:true');
    expect(values.get('capy.theme')).toBe('frappe');
  }
);
