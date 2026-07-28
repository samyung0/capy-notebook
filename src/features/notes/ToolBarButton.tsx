import { cn } from '@/lib/cn';

export function ToolbarButton({
  label,
  children,
  onClick,
  active,
  disabled,
  className,
  ...rest
}: React.ComponentProps<'button'> & {
  label: string;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "relative inline-flex size-8 shrink-0 items-center justify-center gap-1 rounded-button px-0.5 outline-none",
        "hover:bg-surface-hover-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-focus",
        "disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4",
        "select-none whitespace-nowrap font-semibold outline-none transition-all duration-150",
        // active && 'bg-tint-accent-1/35 text-tint-accent-1-fg',
        className,
      )}
      data-plate-prevent-deselect
      data-slot="button"
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      title={label}
      type="button"
      {...rest}
    >
      {children}
    </button>
  );
}
