import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { cn } from '@/lib/cn';
import { useHorizontalWheelScroll } from '@/lib/useHorizontalWheelScroll';

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
  useHorizontalWheelScroll(rowRef);
  const items = tabs.map(norm);
  const focusable = items.some((t) => t.value === value)
    ? value
    : items[0]?.value;

  // WAI-ARIA tabs with automatic activation: arrows, Home and End select and
  // focus the target tab; only the selected tab sits in the Tab order.
  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    const last = items.length - 1;
    const next = {
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowRight: index === last ? 0 : index + 1,
      End: last,
      Home: 0,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    rowRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
    onChange?.(items[next].value);
  };

  return (
    <div
      className={cn(
        'scroll-fade-x flex w-full shrink-0 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        bottomBorder && 'inset-shadow-[0_-1px_var(--color-divider)]',
        className
      )}
      ref={rowRef}
      role="tablist"
    >
      {items.map((t, index) => {
        const active = t.value === value;
        return (
          <button
            aria-selected={active}
            className={cn(
              'shrink-0 px-3 py-2 font-semibold text-sm transition-colors focus-visible:ring-inset',
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
            onKeyDown={(event) => onKeyDown(event, index)}
            role="tab"
            tabIndex={t.value === focusable ? 0 : -1}
            type="button"
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
