import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** An icon-over-label card button: the Add file dialog's kind tiles and the
 * sign-in OAuth buttons. Passing `selected` makes it a toggle. */
export function Tile({
  icon,
  label,
  selected,
  className,
  ...rest
}: Omit<ComponentProps<'button'>, 'children'> & {
  icon: ReactNode;
  label: string;
  selected?: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        'flex flex-col items-center gap-1.5 rounded-card border px-2 py-3 font-medium text-sm transition-colors',
        selected
          ? 'border-solid-accent-1 bg-tint-accent-1/60'
          : 'border-line hover:bg-surface-hover-bg',
        className
      )}
      type="button"
      {...rest}
    >
      {icon}
      {label}
    </button>
  );
}
