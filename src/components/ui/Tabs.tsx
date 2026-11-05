import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { useHorizontalWheelScroll } from '@/lib/useHorizontalWheelScroll';
import { usePointerDownPress } from '@/lib/usePointerDownPress';

type Tab = string | { value: string; label: ReactNode; tone?: 'danger' };

export interface TabsProps {
  bottomBorder?: boolean;
  className?: string;
  onChange?: (value: string) => void;
  /** Vertical: arrows up and down, no underline. Phones get one card of rows,
   * wider screens a plain column. */
  orientation?: 'horizontal' | 'vertical';
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
  orientation = 'horizontal',
}: TabsProps) {
  const vertical = orientation === 'vertical';
  const underline = bottomBorder && !vertical;
  const rowRef = useRef<HTMLDivElement>(null);
  useHorizontalWheelScroll(rowRef);
  const press = usePointerDownPress();
  const items = tabs.map(norm);
  // On a phone a link or the arrow keys can select a tab past the row's edge.
  useEffect(() => {
    const row = rowRef.current;
    const tab = row?.querySelector('[aria-selected="true"]');
    if (!(row && tab) || vertical) return;
    const box = row.getBoundingClientRect();
    const { left, right } = tab.getBoundingClientRect();
    if (right > box.right) row.scrollLeft += right - box.right;
    else if (left < box.left) row.scrollLeft -= box.left - left;
  }, [value, vertical]);
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
      [vertical ? 'ArrowUp' : 'ArrowLeft']: index === 0 ? last : index - 1,
      [vertical ? 'ArrowDown' : 'ArrowRight']: index === last ? 0 : index + 1,
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
      aria-orientation={orientation}
      className={cn(
        vertical
          ? 'flex w-full flex-col overflow-hidden rounded-card bg-surface-hover-bg sm:gap-0.5 sm:overflow-visible sm:rounded-none sm:bg-transparent'
          : 'scroll-fade-x flex w-full shrink-0 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        // --divider itself: --color-divider resolves on the root, so it would
        // miss a frosted panel's translucent divider.
        underline && 'inset-shadow-[0_-1px_var(--divider)]',
        className
      )}
      ref={rowRef}
      role="tablist"
    >
      {items.map((t, index) => {
        const active = t.value === value;
        const { onClick, onPointerDown } = press(() => onChange?.(t.value));
        return (
          <button
            aria-selected={active}
            className={cn(
              'shrink-0 transition-colors focus-visible:ring-inset',
              vertical
                ? 'group/tab text-left font-medium text-base sm:rounded-button sm:px-3.5 sm:py-2 sm:font-semibold sm:text-sm'
                : 'px-3 py-2 font-semibold text-sm',
              underline && 'border-b-2',
              active
                ? cn(
                    'font-bold text-fg',
                    vertical
                      ? 'sm:bg-surface-hover-bg sm:font-bold'
                      : 'border-action'
                  )
                : cn(
                    'border-transparent hover:text-fg',
                    vertical
                      ? 'text-fg sm:text-fg-muted sm:hover:bg-surface-hover-bg'
                      : 'text-fg-muted'
                  ),
              t.tone === 'danger' &&
                (active
                  ? 'border-solid-error text-solid-error'
                  : 'text-solid-error hover:text-tint-error-fg')
            )}
            key={t.value}
            onClick={onClick}
            onKeyDown={(event) => onKeyDown(event, index)}
            onPointerDown={(event) => {
              // A swipe across an overflowing row scrolls it, as a swipe down a
              // column may scroll its page; that touch switches tabs on release
              // instead.
              const row = rowRef.current;
              if (
                event.pointerType === 'touch' &&
                row &&
                (vertical || row.scrollWidth > row.clientWidth)
              )
                return;
              onPointerDown(event);
            }}
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
