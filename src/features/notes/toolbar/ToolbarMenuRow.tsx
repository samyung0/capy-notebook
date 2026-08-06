import { cn } from '@/lib/cn';

export function MenuRow({
  label,
  onClick,
  icon,
  shortcut,
  className,
  onMouseDown,
  ...rest
}: React.ComponentProps<'button'> & {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  className?: string;
}) {
  return (
    <button
      className={cn(
        'flex w-full items-center gap-2 rounded-button px-2 py-1.5 text-left text-fg text-sm hover:bg-surface-hover-bg [&_svg]:size-4',
        className
      )}
      onClick={onClick}
      onMouseDown={(event) => {
        event.preventDefault();
        onMouseDown?.(event);
      }}
      type="button"
      {...rest}
    >
      {icon && (
        <span className="flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">{label}</span>
      {shortcut && (
        <kbd aria-hidden className="ml-auto shrink-0 text-fg-muted text-xs">
          {shortcut}
        </kbd>
      )}
    </button>
  );
}
