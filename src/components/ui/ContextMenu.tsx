import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/cn';
import { Icon } from './Icon';
import {
  focusReopenedSubmenu,
  MenuOpenContext,
  useMenuOpenState,
} from './menuOpenState';

function ContextMenu(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Root>
) {
  const [open, onOpenChange] = useMenuOpenState(props);
  return (
    <MenuOpenContext.Provider value={open}>
      <ContextMenuPrimitive.Root {...props} onOpenChange={onOpenChange} />
    </MenuOpenContext.Provider>
  );
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
  const open = React.useContext(MenuOpenContext);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        aria-hidden={!open || undefined}
        className={cn(
          'z-50 min-w-40 overflow-hidden rounded-card border border-line bg-surface p-1 text-fg shadow-pop outline-none',
          'motion-fade',
          className
        )}
        data-slot="context-menu-content"
        inert={!open}
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
        'relative flex cursor-default select-none items-center gap-2 rounded-button px-2 py-1.5 text-sm outline-none',
        'focus:bg-surface-hover-bg data-highlighted:bg-surface-hover-bg',
        'data-disabled:pointer-events-none data-disabled:opacity-40',
        'data-inset:pl-8 [&_svg]:size-4 [&_svg]:shrink-0',
        className
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
      className={cn('-mx-1 my-1 h-px bg-divider', className)}
      data-slot="context-menu-separator"
      {...props}
    />
  );
}

function ContextMenuSub(
  props: React.ComponentProps<typeof ContextMenuPrimitive.Sub>
) {
  const parentOpen = React.useContext(MenuOpenContext);
  const [open, onOpenChange] = useMenuOpenState(props);
  return (
    <MenuOpenContext.Provider value={parentOpen && open}>
      <ContextMenuPrimitive.Sub {...props} onOpenChange={onOpenChange} />
    </MenuOpenContext.Provider>
  );
}

function ContextMenuSubTrigger({
  children,
  className,
  inset,
  onKeyDown,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-button px-2 py-1.5 text-sm outline-none',
        'focus:bg-surface-hover-bg data-[state=open]:bg-surface-hover-bg data-highlighted:bg-surface-hover-bg',
        'data-disabled:pointer-events-none data-inset:pl-8 data-disabled:opacity-40',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className
      )}
      data-inset={inset || undefined}
      data-slot="context-menu-sub-trigger"
      onKeyDown={(event) => {
        onKeyDown?.(event);
        focusReopenedSubmenu(event);
      }}
      {...props}
    >
      {children}
      <Icon className="ml-auto size-4 text-fg-muted" name="chevronRight" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  const open = React.useContext(MenuOpenContext);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        aria-hidden={!open || undefined}
        className={cn(
          'motion-popup motion-blur-in z-50 min-w-40 overflow-hidden rounded-card border border-line bg-surface p-1 text-fg shadow-pop outline-none',
          className
        )}
        data-slot="context-menu-sub-content"
        inert={!open}
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
