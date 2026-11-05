import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A card's ⋮ over its top right corner, the one button of the workspace and file
 * cards (Epo 2026-11-05); the card places it with `className`. From 1280px with a
 * mouse it shows on the card's hover (`group/card`), focus or while its menu is
 * open; narrower and on touch screens it always shows, as there may be no mouse
 * to hover with. Its backing is the card's colour, frosted, feathering out past
 * its edge so it sits softly on any cover or thumbnail.
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
        // The button fades, not this wrapper: under an ancestor fading below
        // full opacity, Chrome's backdrop blur sees nothing behind it, and
        // it snaps to the blurred thumbnail when the fade ends.
        'absolute z-10 xl:[&_button]:opacity-0 xl:pointer-coarse:[&_button]:opacity-100 xl:has-data-[state=open]:[&_button]:opacity-100 xl:group-hover/card:[&_button]:opacity-100 xl:focus-within:[&_button]:opacity-100',
        '[&_button>svg]:size-4.5 [&_button]:size-8 [&_button]:rounded-md [&_button]:bg-surface/70 [&_button]:p-0 [&_button]:shadow-[0_0_8px_4px_color-mix(in_srgb,var(--color-surface)_55%,transparent)] [&_button]:backdrop-blur-sm [&_button]:hover:bg-surface',
        className
      )}
    >
      {children}
    </div>
  );
}
