import { Popover as PopoverPrimitive } from 'radix-ui';
import { cn } from '@/lib/cn';
import { PopupMotion } from './PopupMotion';

/** The compact action row shared by selected document and question blocks. */
export function BlockToolbar({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      role="toolbar"
      {...props}
      className={cn(
        'flex w-fit max-w-[90vw] items-center gap-0 overflow-x-auto rounded-input border border-line bg-surface p-1 shadow-pop',
        '[&_[data-toolbar-group]]:after:hidden',
        className
      )}
    />
  );
}

/** Position stays on the outer node while the shared toolbar animates inside it. */
export function FloatingToolbar({
  children,
  className,
  ...props
}: Omit<React.ComponentProps<typeof PopupMotion>, 'asChild'>) {
  return (
    <PopupMotion asChild {...props}>
      <BlockToolbar className={cn('px-2', className)}>{children}</BlockToolbar>
    </PopupMotion>
  );
}

export function FloatingBlockToolbar({
  children,
  className,
  open,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & { open: boolean }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align="center"
        asChild
        avoidCollisions={false}
        className={cn(
          'motion-popup motion-blur-in z-50 px-1.5 outline-hidden data-[state=closed]:[animation-fill-mode:forwards]',
          className
        )}
        contentEditable={false}
        data-slot="popover-content"
        // Pair with `collisionBoundary` so it hides with its block when that
        // scrolls out of a clipped area.
        hideWhenDetached
        inert={!open}
        onOpenAutoFocus={(event) => event.preventDefault()}
        side="bottom"
        sideOffset={8}
        {...props}
      >
        <BlockToolbar>{children}</BlockToolbar>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
