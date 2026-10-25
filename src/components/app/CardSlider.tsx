import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/** One row of cards scrolling sideways inside the content width (the
 * Dashboard's recent workspaces, the Study page's Quick review); the scroll
 * fade marks the hidden cards. Only the right edge fades, so the card at the
 * left edge stays at full strength. Its inline size never counts toward its
 * parents', so a long row cannot widen the page. */
export function CardSlider({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'scroll-fade-x flex gap-4 overflow-x-auto pt-1 pb-2 [--scroll-fade-start:0px]! [contain:inline-size] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className
      )}
      {...props}
    />
  );
}
