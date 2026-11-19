import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A card's ⋮ over its top right corner, the one button of the workspace and file
 * cards (Epo 2026-11-05); the card places it with `className`. With a mouse, at
 * any width (Epo 2026-11-19), it shows on the card's hover (`group/card`), focus
 * or while its menu is open; on a touch screen it always shows, as there is no
 * mouse to hover with. It is 24px, with a larger invisible hit area for fingers.
 */
export function CardActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'absolute z-10 pointer-fine:[&_button]:opacity-0 pointer-fine:focus-within:[&_button]:opacity-100 pointer-fine:group-hover/card:[&_button]:opacity-100 pointer-fine:has-data-[state=open]:[&_button]:opacity-100',
        '[&_button>svg]:size-4 [&_button]:size-6 [&_button]:rounded-full [&_button]:bg-surface [&_button]:p-0 [&_button]:after:absolute [&_button]:after:-inset-2 [&_button]:hover:bg-surface-hover-bg',
        className
      )}
    >
      {children}
    </div>
  );
}
