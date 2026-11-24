import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** An icon-over-label card button: the Add file dialog's kind tiles, the
 * sign-in OAuth buttons, and with `description` (a muted line under the
 * label, both left-aligned) the ways New quiz makes a quiz. Passing
 * `selected` makes it a toggle. */
export function Tile({
  icon,
  label,
  description,
  selected,
  className,
  ...rest
}: Omit<ComponentProps<'button'>, 'children'> & {
  icon: ReactNode;
  label: string;
  description?: ReactNode;
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
      {description ? (
        <span className="flex min-w-0 flex-col justify-center gap-0.5 self-stretch text-left">
          {label}
          <span className="t-meta font-normal text-fg-muted">
            {description}
          </span>
        </span>
      ) : (
        label
      )}
    </button>
  );
}
