import { Popover as PopoverPrimitive } from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/cn';

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return (
    <PopoverAnchor asChild>
      <span className="inline-flex min-w-0 shrink-0">
        <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
      </span>
    </PopoverAnchor>
  );
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  alignWidthToTrigger,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  alignWidthToTrigger?: boolean;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        className={cn(
          'motion-anchored-popup z-50 flex w-72 flex-col gap-2.5 rounded-lg border border-line bg-surface p-2.5 shadow-pop outline-hidden',
          alignWidthToTrigger && 'w-(--radix-popover-trigger-width)!',
          className
        )}
        data-slot="popover-content"
        sideOffset={sideOffset}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

const PopoverClose = PopoverPrimitive.Close;

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return (
    <div className={cn('', className)} data-slot="popover-title" {...props} />
  );
}

export {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
};
