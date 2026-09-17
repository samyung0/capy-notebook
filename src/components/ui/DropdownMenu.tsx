import { Anchor as MenuAnchor } from '@radix-ui/react-menu';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/cn';
import { Icon } from './Icon';
import {
  focusReopenedSubmenu,
  MenuOpenContext,
  useMenuOpenState,
} from './menuOpenState';

const useDropdownScope = DropdownMenuPrimitive.createDropdownMenuScope();
const DropdownScopeContext = React.createContext<ReturnType<
  typeof useDropdownScope
> | null>(null);

function useDropdownMenuScope() {
  return React.useContext(DropdownScopeContext);
}

function DropdownMenu(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>
) {
  const [open, onOpenChange] = useMenuOpenState(props);
  const scope = useDropdownScope(undefined);
  return (
    <DropdownScopeContext.Provider value={scope}>
      <MenuOpenContext.Provider value={open}>
        <DropdownMenuPrimitive.Root
          {...scope}
          {...props}
          onOpenChange={onOpenChange}
        />
      </MenuOpenContext.Provider>
    </DropdownScopeContext.Provider>
  );
}

function DropdownMenuTrigger(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>
) {
  const scope = useDropdownMenuScope();
  return (
    <MenuAnchor asChild {...{ __scopeMenu: scope?.__scopeDropdownMenu }}>
      <span className="inline-flex min-w-0" data-slot="dropdown-menu-anchor">
        <DropdownMenuPrimitive.Trigger
          {...scope}
          data-slot="dropdown-menu-trigger"
          {...props}
        />
      </span>
    </MenuAnchor>
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const open = React.useContext(MenuOpenContext);
  const scope = useDropdownMenuScope();
  return (
    <DropdownMenuPrimitive.Portal {...scope}>
      <DropdownMenuPrimitive.Content
        {...scope}
        aria-hidden={!open || undefined}
        className={cn(
          'z-50 min-w-40 overflow-hidden rounded-card border border-line bg-surface p-1 text-fg shadow-pop outline-none',
          'motion-anchored-popup',
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
    <DropdownMenuPrimitive.Group
      {...useDropdownMenuScope()}
      data-slot="dropdown-menu-group"
      {...props}
    />
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
      {...useDropdownMenuScope()}
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
      {...useDropdownMenuScope()}
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
        <DropdownMenuPrimitive.ItemIndicator {...useDropdownMenuScope()}>
          <Icon className="size-4" name="check" />
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
      {...useDropdownMenuScope()}
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
      <DropdownMenuPrimitive.Sub
        {...useDropdownMenuScope()}
        {...props}
        onOpenChange={onOpenChange}
      />
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
      {...useDropdownMenuScope()}
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
      <Icon className="ml-auto size-4 text-fg-muted" name="chevronRight" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  sideOffset = 2,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const open = React.useContext(MenuOpenContext);
  const scope = useDropdownMenuScope();
  return (
    <DropdownMenuPrimitive.Portal {...scope}>
      <DropdownMenuPrimitive.SubContent
        {...scope}
        aria-hidden={!open || undefined}
        className={cn(
          'motion-anchored-popup z-50 min-w-40 overflow-hidden rounded-card border border-line bg-surface p-1 text-fg shadow-pop outline-none',
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
