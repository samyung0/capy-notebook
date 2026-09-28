import { type ReactNode, useRef, useState } from 'react';
import { BlockToolbar } from '@/components/ui/BlockToolbar';
import { cn } from '@/lib/cn';

const MIN_WIDTH_PERCENT = 20;

interface Drag {
  direction: 1 | -1;
  moved: boolean;
  parentWidth: number;
  startWidth: number;
  startX: number;
}

/**
 * Box around an image or embed. Shows `toolbar` in the top-right corner on
 * hover and, with `onWidthChange`, side handles that resize it symmetrically
 * and report the width as a percentage of the block.
 */
export function MediaFrame({
  children,
  fill = false,
  onWidthChange,
  toolbar,
  width,
}: {
  children: ReactNode;
  /** Take the full block width when no width is stored (embeds). */
  fill?: boolean;
  onWidthChange?: (width: string) => void;
  toolbar?: ReactNode;
  width?: string | number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragWidth, setDragWidth] = useState<string>();

  const widthAt = (clientX: number) => {
    const { direction, parentWidth, startWidth, startX } = drag.current!;
    // Both edges move, so the width changes by twice the pointer travel.
    const percent =
      ((startWidth + 2 * direction * (clientX - startX)) / parentWidth) * 100;
    return `${Math.round(Math.min(100, Math.max(MIN_WIDTH_PERCENT, percent)))}%`;
  };

  const handle = (side: 'left' | 'right') => (
    <span
      aria-hidden
      className={cn(
        'absolute top-1/2 z-10 h-12 w-1.5 -translate-y-1/2 cursor-ew-resize touch-none rounded-full border border-black/35 bg-white/95 opacity-0 shadow-sm transition-opacity group-hover/media:opacity-100',
        side === 'left' ? 'left-2' : 'right-2',
        dragWidth &&
          'border-solid-accent-1 opacity-100 ring-3 ring-solid-accent-1/35'
      )}
      data-media-resize-handle={side}
      onPointerCancel={() => {
        drag.current = null;
        setDragWidth(undefined);
      }}
      onPointerDown={(event) => {
        const frame = ref.current;
        if (!frame?.parentElement) return;
        event.preventDefault();
        event.stopPropagation();
        // Capture keeps the drag alive over an embedded iframe.
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          direction: side === 'left' ? -1 : 1,
          moved: false,
          parentWidth: frame.parentElement.clientWidth,
          startWidth: frame.offsetWidth,
          startX: event.clientX,
        };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        if (Math.abs(event.clientX - drag.current.startX) > 2)
          drag.current.moved = true;
        if (drag.current.moved) setDragWidth(widthAt(event.clientX));
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        const next = drag.current.moved ? widthAt(event.clientX) : undefined;
        drag.current = null;
        setDragWidth(undefined);
        if (next && next !== width) onWidthChange?.(next);
      }}
    />
  );

  const current = dragWidth ?? width;
  return (
    <div
      className={cn(
        'group/media relative mx-auto max-w-full',
        current === undefined && (fill ? 'w-full' : 'w-fit'),
        dragWidth &&
          'rounded-card outline-2 outline-solid-accent-1 outline-offset-2'
      )}
      ref={ref}
      style={current === undefined ? undefined : { width: current }}
    >
      {children}
      {toolbar && (
        <BlockToolbar
          className={cn(
            'absolute top-2 right-2 z-10 rounded-md p-0.5 opacity-0 transition-opacity',
            'pointer-coarse:opacity-100 group-hover/media:opacity-100 has-data-[state=open]:opacity-100 has-focus-visible:opacity-100',
            '[&_a]:size-7 [&_button]:size-7'
          )}
        >
          {toolbar}
        </BlockToolbar>
      )}
      {onWidthChange && handle('left')}
      {onWidthChange && handle('right')}
    </div>
  );
}
