import { useEditorRef } from 'platejs/react';
import { Button } from '@/components/ui/Button';
import { PopoverClose, PopoverContent } from '@/components/ui/Popover';
import { cn } from '@/lib/cn';

/** Preserve focus handed to an editor command or its dialog. */
export function ToolbarPopoverContent({
  open,
  ...props
}: React.ComponentProps<typeof PopoverContent> & { open: boolean }) {
  const editor = useEditorRef();
  return (
    <PopoverContent
      aria-hidden={!open || undefined}
      inert={!open}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={() => editor.tf.focus()}
      {...props}
    />
  );
}

export function ToolbarPopoverRow({
  label,
  icon,
  shortcut,
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button> & {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
}) {
  const editor = useEditorRef();
  return (
    <PopoverClose asChild>
      <Button
        className={cn(
          'h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal [&_svg]:size-4',
          className
        )}
        onClick={(event) => {
          onClick?.(event);
          if (
            !event.defaultPrevented &&
            document.activeElement?.closest('[data-slot="popover-content"]')
          )
            editor.tf.focus();
        }}
        size="sm"
        type="button"
        variant="ghost-hover"
        {...props}
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
      </Button>
    </PopoverClose>
  );
}
