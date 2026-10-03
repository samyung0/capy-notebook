import { Menubar as MenubarPrimitive } from 'radix-ui';
import type * as React from 'react';
import { createContext, useContext, useRef } from 'react';
import { cn } from '@/lib/cn';
import { Icon } from './Icon';
import { focusReopenedSubmenu } from './menuOpenState';

/**
 * A menu bar (File, Edit, View…) in DropdownMenu's look: arrow keys move
 * between its menus and assistive technology announces a menu bar.
 */
function Menubar({
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Root>) {
  return (
    <MenubarPrimitive.Root
      className={cn('flex items-center', className)}
      data-slot="menubar"
      {...props}
    />
  );
}

/** Set while a click on a closed menu's trigger opens it. */
const ReopeningContext = createContext<React.RefObject<boolean> | null>(null);

function MenubarMenu(
  props: React.ComponentProps<typeof MenubarPrimitive.Menu>
) {
  const reopening = useRef(false);
  return (
    <ReopeningContext.Provider value={reopening}>
      <MenubarPrimitive.Menu {...props} />
    </ReopeningContext.Provider>
  );
}

const MenubarSub = MenubarPrimitive.Sub;

function MenubarTrigger({
  onPointerDown,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Trigger>) {
  const reopening = useContext(ReopeningContext);
  return (
    <MenubarPrimitive.Trigger
      data-slot="menubar-trigger"
      onPointerDown={(event) => {
        if (reopening && event.currentTarget.dataset.state === 'closed') {
          reopening.current = true;
          // Only for this pointerdown's own dispatch.
          setTimeout(() => {
            reopening.current = false;
          });
        }
        onPointerDown?.(event);
      }}
      {...props}
    />
  );
}

type ContentProps = React.ComponentProps<typeof MenubarPrimitive.Content>;

/**
 * A closed menu stays mounted for its exit animation, its outside listeners
 * still live: focus moving into the next menu (ArrowRight), a click on the
 * next trigger, or a click on its own trigger reopening it must not dismiss
 * it, which would close the menu just opened.
 */
function useClosingGuard({
  onFocusOutside,
  onPointerDownOutside,
}: Pick<ContentProps, 'onFocusOutside' | 'onPointerDownOutside'>) {
  const ref = useRef<HTMLDivElement>(null);
  const reopening = useContext(ReopeningContext);
  const closing = (event: Event) => {
    if (ref.current?.dataset.state === 'closed' || reopening?.current)
      event.preventDefault();
  };
  return {
    onFocusOutside: (
      event: Parameters<NonNullable<typeof onFocusOutside>>[0]
    ) => {
      closing(event);
      onFocusOutside?.(event);
    },
    onPointerDownOutside: (
      event: Parameters<NonNullable<typeof onPointerDownOutside>>[0]
    ) => {
      closing(event);
      onPointerDownOutside?.(event);
    },
    ref,
  };
}

function MenubarContent({
  className,
  sideOffset = 4,
  onFocusOutside,
  onPointerDownOutside,
  ...props
}: ContentProps) {
  const guard = useClosingGuard({ onFocusOutside, onPointerDownOutside });
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.Content
        {...guard}
        className={cn(
          'motion-anchored-popup z-50 min-w-40 overflow-hidden rounded-card border border-line bg-surface p-1 text-fg shadow-pop outline-none',
          className
        )}
        data-slot="menubar-content"
        sideOffset={sideOffset}
        {...props}
      />
    </MenubarPrimitive.Portal>
  );
}

function MenubarItem({
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Item>) {
  return (
    <MenubarPrimitive.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-button px-2 py-1.5 text-sm outline-none',
        'focus:bg-surface-hover-bg data-[highlighted]:bg-surface-hover-bg',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className
      )}
      data-slot="menubar-item"
      {...props}
    />
  );
}

function MenubarSeparator({
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Separator>) {
  return (
    <MenubarPrimitive.Separator
      className={cn('pointer-events-none my-1 h-px bg-divider', className)}
      data-slot="menubar-separator"
      {...props}
    />
  );
}

function MenubarSubTrigger({
  children,
  className,
  onKeyDown,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.SubTrigger>) {
  return (
    <MenubarPrimitive.SubTrigger
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-button px-2 py-1.5 text-sm outline-none',
        'focus:bg-surface-hover-bg data-[highlighted]:bg-surface-hover-bg data-[state=open]:bg-surface-hover-bg',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className
      )}
      data-slot="menubar-sub-trigger"
      onKeyDown={(event) => {
        onKeyDown?.(event);
        focusReopenedSubmenu(event);
      }}
      {...props}
    >
      {children}
      <Icon className="ml-auto size-4 text-fg-muted" name="chevronRight" />
    </MenubarPrimitive.SubTrigger>
  );
}

function MenubarSubContent({
  className,
  sideOffset = 2,
  onFocusOutside,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.SubContent>) {
  const guard = useClosingGuard({ onFocusOutside, onPointerDownOutside });
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.SubContent
        {...guard}
        className={cn(
          'motion-anchored-popup z-50 min-w-40 overflow-hidden rounded-card border border-line bg-surface p-1 text-fg shadow-pop outline-none',
          className
        )}
        data-slot="menubar-sub-content"
        sideOffset={sideOffset}
        {...props}
      />
    </MenubarPrimitive.Portal>
  );
}

export {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
};
