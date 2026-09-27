import { type ReactNode, useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

type Tab = string | { value: string; label: ReactNode; tone?: 'danger' };

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
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    const onWheel = (event: WheelEvent) => {
      if (
        event.defaultPrevented ||
        !event.cancelable ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.deltaX !== 0
      )
        return;

      const mode = event.deltaMode;
      let delta = event.deltaY;
      if (!delta) return;

      const width = row.clientWidth;
      const maxScroll = row.scrollWidth - width;
      if (maxScroll <= 0) return;

      if (mode === WheelEvent.DOM_DELTA_LINE) {
        delta *= Number.parseFloat(getComputedStyle(row).lineHeight);
      } else if (mode === WheelEvent.DOM_DELTA_PAGE) {
        delta *= width;
      }

      const left = row.scrollLeft;
      const next = Math.max(0, Math.min(maxScroll, left + delta));
      if (next === left) return;

      event.preventDefault();
      row.scrollLeft = next;
    };

    // React's onWheel is passive; cancel only wheel input consumed by this row.
    row.addEventListener('wheel', onWheel, { passive: false });
    return () => row.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      className={cn(
        'scroll-fade-x flex w-full shrink-0 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        bottomBorder && 'inset-shadow-[0_-1px_var(--color-divider)]',
        className
      )}
      ref={rowRef}
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
