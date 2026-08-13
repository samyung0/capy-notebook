import { ButtonTooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/cn';

/** Shortcuts that are actually registered on the Plate editor. */
export const EDITOR_SHORTCUTS = {
  ai: 'Ctrl/Cmd+J',
  bold: 'Ctrl/Cmd+B',
  code: 'Ctrl/Cmd+E',
  highlight: 'Ctrl/Cmd+Shift+H',
  italic: 'Ctrl/Cmd+I',
  redo: 'Ctrl/Cmd+Shift+Z',
  strikethrough: 'Ctrl/Cmd+Shift+X',
  underline: 'Ctrl/Cmd+U',
  undo: 'Ctrl/Cmd+Z',
} as const;

export function ToolbarButton({
  label,
  shortcut,
  children,
  onClick,
  active,
  disabled,
  className,
  tooltipSide = 'bottom',
  ...rest
}: React.ComponentProps<'button'> & {
  label: string;
  shortcut?: string;
  active?: boolean;
  className?: string;
  tooltipSide?: 'top' | 'bottom';
}) {
  return (
    <ButtonTooltip label={label} shortcut={shortcut} side={tooltipSide}>
      <button
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'relative inline-flex size-8 shrink-0 items-center justify-center gap-1 rounded-button px-0.5 outline-none',
          'hover:bg-surface-hover-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-focus',
          'disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4',
          'select-none whitespace-nowrap font-semibold outline-none transition-all duration-150',
          className
        )}
        data-plate-prevent-deselect
        data-slot="button"
        disabled={disabled}
        onClick={onClick}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
        {...rest}
      >
        {children}
      </button>
    </ButtonTooltip>
  );
}
