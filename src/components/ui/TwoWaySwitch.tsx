import { cn } from '@/lib/cn';

/** A choice of two, side by side: full width on phones, its natural width from
 * sm, both sides as wide as the wider. As tall as an input or a select. */
export function TwoWaySwitch<T extends string>({
  className,
  disabled,
  label,
  onChange,
  options,
  value,
}: {
  className?: string;
  disabled?: boolean;
  label: string;
  onChange: (value: T) => void;
  options: readonly [{ label: string; value: T }, { label: string; value: T }];
  value: T;
}) {
  return (
    <div
      aria-label={label}
      className={cn(
        'grid w-full grid-cols-2 overflow-hidden rounded-input border border-line sm:inline-grid sm:w-auto',
        className
      )}
      role="group"
    >
      {options.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={cn(
            'h-[calc(var(--control-h)-2px)] whitespace-nowrap not-first:border-line not-first:border-l px-5 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset disabled:cursor-default',
            value === option.value
              ? 'bg-action text-action-fg'
              : 'text-fg-secondary hover:bg-surface-hover-bg'
          )}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
