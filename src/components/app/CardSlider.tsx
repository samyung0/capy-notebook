import { type ComponentProps, useCallback, useState } from 'react';
import { cn } from '@/lib/cn';
import { useHorizontalWheelScroll } from '@/lib/useHorizontalWheelScroll';

/** One row of cards scrolling sideways inside the content width (the
 * Dashboard's recent workspaces, the Study page's Quick review); the scroll
 * fade marks the hidden cards, and the mouse wheel scrolls it as the editor
 * toolbars do. Only the right edge fades, so the card at the left edge stays
 * at full strength. Its inline size never counts toward its parents', so a
 * long row cannot widen the page. */
export function CardSlider({
  className,
  ref,
  ...props
}: ComponentProps<'div'>) {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  useHorizontalWheelScroll(row);
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      setRow(node);
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref]
  );
  return (
    <div
      className={cn(
        'scroll-fade-x flex gap-4 overflow-x-auto pt-1 pb-2 [--scroll-fade-start:0px]! [contain:inline-size] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className
      )}
      ref={setRef}
      {...props}
    />
  );
}
