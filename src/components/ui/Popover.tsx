import { Popover as PopoverPrimitive } from 'radix-ui';
import * as React from 'react';
import { useEditorHeld } from '@/features/collaboration/CollaborationHold';

import { cn } from '@/lib/cn';

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

/** Toggles on pointerdown like the dropdown menus: the press replays as a
 * keyboard-style click (`detail` 0) that Radix toggles on, and the real click
 * after release is prevented so it does not toggle back. Preventing the
 * pointerdown keeps focus from leaving the opened popover. */
function PopoverTrigger({
  onClick,
  onPointerDown,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const pressed = React.useRef(false);
  return (
    <PopoverAnchor asChild>
      <span className="inline-flex min-w-0 shrink-0">
        <PopoverPrimitive.Trigger
          data-slot="popover-trigger"
          onClick={(event) => {
            onClick?.(event);
            if (pressed.current && event.detail > 0) event.preventDefault();
            pressed.current = false;
          }}
          onPointerDown={(event) => {
            onPointerDown?.(event);
            if (event.defaultPrevented || event.button !== 0 || event.ctrlKey)
              return;
            event.preventDefault();
            event.currentTarget.click();
            pressed.current = true;
          }}
          {...props}
        />
      </span>
    </PopoverAnchor>
  );
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  alignWidthToTrigger,
  container,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  alignWidthToTrigger?: boolean;
  container?: React.ComponentProps<typeof PopoverPrimitive.Portal>['container'];
}) {
  const held = useEditorHeld();
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Content
        align={align}
        className={cn(
          'motion-anchored-popup z-50 flex w-72 flex-col gap-2.5 rounded-lg border border-overlay-line bg-overlay p-2.5 shadow-pop outline-hidden',
          alignWidthToTrigger && 'w-(--radix-popover-trigger-width)!',
          className
        )}
        data-slot="popover-content"
        inert={held}
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
