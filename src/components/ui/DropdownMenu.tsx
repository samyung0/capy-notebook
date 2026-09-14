import { Check, ChevronRight } from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/cn';
import {
  focusReopenedSubmenu,
  MenuOpenContext,
  useMenuOpenState,
} from './menuOpenState';

function DropdownMenu(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>
) {
  const [open, onOpenChange] = useMenuOpenState(props);
  return (
    <MenuOpenContext.Provider value={open}>
      <DropdownMenuPrimitive.Root {...props} onOpenChange={onOpenChange} />
    </MenuOpenContext.Provider>
  );
}

function DropdownMenuTrigger(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>
) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const open = React.useContext(MenuOpenContext);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        aria-hidden={!open || undefined}
        className={cn(
          'z-50 min-w-40 overflow-hidden rounded-card border border-line bg-surface p-1 text-fg shadow-pop outline-none',
          'motion-fade',
          className
        )}
        data-slot="dropdown-menu-content"
        inert={!open}
        sideOffset={sideOffset}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Group>
) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  );
}

function DropdownMenuItem({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-button px-2 py-1.5 text-sm outline-none',
        'focus:bg-surface-hover-bg data-[highlighted]:bg-surface-hover-bg',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        'data-[inset]:pl-8 [&_svg]:size-4 [&_svg]:shrink-0',
        className
      )}
      data-inset={inset || undefined}
      data-slot="dropdown-menu-item"
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  children,
  className,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        'relative flex cursor-default select-none items-center rounded-button py-1.5 pr-2 pl-8 text-sm outline-none',
        'focus:bg-surface-hover-bg data-[highlighted]:bg-surface-hover-bg',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        className
      )}
      data-slot="dropdown-menu-checkbox-item"
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('-mx-1 my-1 h-px bg-divider', className)}
      data-slot="dropdown-menu-separator"
      {...props}
    />
  );
}

function DropdownMenuSub(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>
) {
  const parentOpen = React.useContext(MenuOpenContext);
  const [open, onOpenChange] = useMenuOpenState(props);
  return (
    <MenuOpenContext.Provider value={parentOpen && open}>
      <DropdownMenuPrimitive.Sub {...props} onOpenChange={onOpenChange} />
    </MenuOpenContext.Provider>
  );
}

function DropdownMenuSubTrigger({
  children,
  className,
  inset,
  onKeyDown,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-button px-2 py-1.5 text-sm outline-none',
        'focus:bg-surface-hover-bg data-[highlighted]:bg-surface-hover-bg data-[state=open]:bg-surface-hover-bg',
        'data-[disabled]:pointer-events-none data-[inset]:pl-8 data-[disabled]:opacity-40',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className
      )}
      data-inset={inset || undefined}
      data-slot="dropdown-menu-sub-trigger"
      onKeyDown={(event) => {
        onKeyDown?.(event);
        focusReopenedSubmenu(event);
      }}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-4 text-fg-muted" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  sideOffset = 2,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const open = React.useContext(MenuOpenContext);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        aria-hidden={!open || undefined}
        className={cn(
          'motion-popup motion-blur-in z-50 min-w-40 overflow-hidden rounded-card border border-line bg-surface p-1 text-fg shadow-pop outline-none',
          className
        )}
        data-slot="dropdown-menu-sub-content"
        inert={!open}
        sideOffset={sideOffset}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
