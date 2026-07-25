import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/cn';
import { STYLES, useTheme } from '@/theme/ThemeProvider';

/** Compact theme + light/dark control for the sidebar footer. */
export function ThemeSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { style, theme, setStyle, setTheme } = useTheme();

  if (collapsed) {
    return (
      <button
        aria-label="Toggle light/dark"
        className="flex h-10 w-10 items-center justify-center rounded-button text-fg hover:bg-surface-hover-bg"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        type="button"
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={19} />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="flex items-center gap-1 rounded-pill border border-line bg-surface p-[3px]">
        {STYLES.map((t) => (
          <button
            className={cn(
              'flex-1 rounded-pill py-1.5 font-semibold text-[12px] transition-colors',
              style === t.value
                ? 'bg-action text-action-fg'
                : 'text-fg-muted hover:text-fg'
            )}
            key={t.value}
            onClick={() => setStyle(t.value)}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>
      <button
        className="flex items-center justify-center gap-2 rounded-button py-2 font-medium text-[13px] text-fg hover:bg-surface-hover-bg"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        type="button"
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        {theme === 'dark' ? 'Light mode' : 'Dark mode'}
      </button>
    </div>
  );
}
