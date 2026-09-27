import { useEditorRef } from 'platejs/react';
import { PopoverClose } from '@/components/ui/Popover';
import {
  ToolbarPopoverContent as SharedToolbarPopoverContent,
  ToolbarPopoverItem,
} from '@/components/ui/ToolbarPopover';
import { cn } from '@/lib/cn';

/** Preserve focus handed to an editor command or its dialog. */
export function ToolbarPopoverContent({
  open,
  className,
  ...props
}: React.ComponentProps<typeof SharedToolbarPopoverContent> & {
  open: boolean;
}) {
  const editor = useEditorRef();
  return (
    <SharedToolbarPopoverContent
      aria-hidden={!open || undefined}
      className={cn('ignore-click-outside/toolbar', className)}
      inert={!open}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => {
        // Escape dismisses this popup, not Plate's underlying block selection.
        event.stopPropagation();
        editor.tf.focus();
      }}
      {...props}
    />
  );
}

export function ToolbarPopoverRow({
  onClick,
  ...props
}: React.ComponentProps<typeof ToolbarPopoverItem>) {
  const editor = useEditorRef();
  return (
    <PopoverClose asChild>
      <ToolbarPopoverItem
        onClick={(event) => {
          onClick?.(event);
          if (
            !event.defaultPrevented &&
            document.activeElement?.closest('[data-slot="popover-content"]')
          )
            editor.tf.focus();
        }}
        {...props}
      />
    </PopoverClose>
  );
}
