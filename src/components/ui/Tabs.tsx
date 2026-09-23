import { cn } from '@/lib/cn';

type Tab = string | { value: string; label: string; tone?: 'danger' };

export interface TabsProps {
  bottomBorder?: boolean;
  className?: string;
  onChange?: (value: string) => void;
  tabs: Tab[];
  value: string;
}

const norm = (t: Tab) =>
  typeof t === 'string' ? { label: t, tone: undefined, value: t } : t;

export function Tabs({
  tabs,
  value,
  onChange,
  className,
  bottomBorder = true,
}: TabsProps) {
  return (
    <div
      className={cn(
        'scroll-fade-x flex w-full shrink-0 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        bottomBorder && 'inset-shadow-[0_-1px_var(--color-divider)]',
        className
      )}
    >
      {tabs.map((tab) => {
        const t = norm(tab);
        const active = t.value === value;
        return (
          <button
            className={cn(
              'shrink-0 px-3 py-2 font-semibold text-sm transition-colors',
              bottomBorder && 'border-b-2',
              active
                ? 'border-action font-bold text-fg'
                : 'border-transparent text-fg-muted hover:text-fg',
              t.tone === 'danger' &&
                (active
                  ? 'border-solid-error text-solid-error'
                  : 'text-solid-error hover:text-tint-error-fg')
            )}
            key={t.value}
            onClick={() => onChange?.(t.value)}
            type="button"
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
