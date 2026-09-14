import { useEditorRef } from 'platejs/react';
import {
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/DropdownMenu';
import { cn } from '@/lib/cn';

export function MenuRow({
  label,
  onSelect,
  icon,
  shortcut,
  className,
  ...rest
}: React.ComponentProps<typeof DropdownMenuItem> & {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  className?: string;
}) {
  const editor = useEditorRef();
  return (
    <DropdownMenuItem
      className={cn(
        'flex w-full items-center gap-2 rounded-button px-2 py-1.5 text-left text-fg text-sm hover:bg-surface-hover-bg [&_svg]:size-4',
        className
      )}
      onSelect={(event) => {
        onSelect?.(event);
        if (
          !event.defaultPrevented &&
          document.activeElement?.closest('[role="menu"]')
        )
          editor.tf.focus();
      }}
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
    </DropdownMenuItem>
  );
}

/** Commands may focus a new editor input or dialog; closing must not take focus back. */
export function ToolbarMenuContent(
  props: React.ComponentProps<typeof DropdownMenuContent>
) {
  const editor = useEditorRef();
  return (
    <DropdownMenuContent
      onCloseAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={() => editor.tf.focus()}
      {...props}
    />
  );
}
