import { ChevronRight } from 'lucide-react';
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/cn';

function ContextMenu(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Root>
) {
  return <ContextMenuPrimitive.Root {...props} />;
}

function ContextMenuTrigger(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>
) {
  return (
    <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
  );
}

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cn(
          'z-50 min-w-40 overflow-hidden rounded-card border border-line bg-surface p-1 text-fg shadow-pop outline-none',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in',
          className
        )}
        data-slot="context-menu-content"
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuGroup(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Group>
) {
  return (
    <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
  );
}

function ContextMenuItem({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-button px-2 py-1.5 text-sm outline-none",
        "focus:bg-surface-hover-bg data-highlighted:bg-surface-hover-bg",
        "data-disabled:pointer-events-none data-disabled:opacity-40",
        "data-inset:pl-8 [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      data-inset={inset || undefined}
      data-slot="context-menu-item"
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-divider", className)}
      data-slot="context-menu-separator"
      {...props}
    />
  );
}

function ContextMenuSub(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Sub>,
) {
  return <ContextMenuPrimitive.Sub {...props} />;
}

function ContextMenuSubTrigger({
  children,
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-button px-2 py-1.5 text-sm outline-none",
        "focus:bg-surface-hover-bg data-[state=open]:bg-surface-hover-bg data-highlighted:bg-surface-hover-bg",
        "data-disabled:pointer-events-none data-inset:pl-8 data-disabled:opacity-40",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      data-inset={inset || undefined}
      data-slot="context-menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-4 text-fg-muted" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        className={cn(
          'z-50 min-w-40 overflow-hidden rounded-card border border-line bg-surface p-1 text-fg shadow-pop outline-none',
          className
        )}
        data-slot="context-menu-sub-content"
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
