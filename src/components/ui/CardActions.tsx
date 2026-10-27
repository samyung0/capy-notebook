import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A card's ⋮ over its top right corner, shared by the workspace and file
 * cards so the button keeps one size, padding, radius and backing; the card
 * places it with `className`. From desktop widths with a mouse it shows on
 * the card's hover (`group/card`), focus or while its menu is open; below
 * them and on touch screens it always shows, since there may be no mouse to
 * hover with. A frosted backing keeps it apart from what lies under it:
 * the card's colour at 60% over a heavy (24px) blur, so a
 * dark thumbnail darkens it instead of a white tile sitting on top; light
 * grey on its own hover; `ink` tints both for a
 * cover. `backing="revealed"` keeps the backing to when it shows on hover,
 * for a card that clears room for an always-shown ⋮ instead.
 */
export function CardActions({
  children,
  className,
  ink = null,
  backing = 'always',
}: {
  children: ReactNode;
  className?: string;
  ink?: 'dark' | 'light' | null;
  backing?: 'always' | 'revealed';
}) {
  const always = backing === 'always';
  return (
    <div
      className={cn(
        // The button fades, not this wrapper: under an ancestor fading below
        // full opacity, Chrome's backdrop blur sees nothing behind it, and
        // it snaps to the blurred thumbnail when the fade ends.
        'absolute z-10 lg:[&_button]:opacity-0 lg:pointer-coarse:[&_button]:opacity-100 lg:has-data-[state=open]:[&_button]:opacity-100 lg:group-hover/card:[&_button]:opacity-100 lg:focus-within:[&_button]:opacity-100',
        always
          ? '[&_button]:backdrop-blur-xl'
          : 'lg:pointer-fine:[&_button]:backdrop-blur-xl',
        !ink &&
          (always
            ? '[&_button]:bg-surface/60 [&_button]:hover:bg-surface-hover-bg'
            : 'lg:pointer-fine:[&_button]:bg-surface/60 lg:pointer-fine:[&_button]:hover:bg-surface-hover-bg'),
        ink === 'dark' && '[&_button]:text-white [&_button]:hover:bg-white/15',
        ink === 'dark' &&
          (always
            ? '[&_button]:bg-black/25 [&_button]:hover:bg-black/35'
            : 'lg:pointer-fine:[&_button]:bg-black/25 lg:pointer-fine:[&_button]:hover:bg-black/35'),
        ink === 'light' &&
          '[&_button]:text-[#1d1d1f] [&_button]:hover:bg-black/8',
        ink === 'light' &&
          (always
            ? '[&_button]:bg-white/60 [&_button]:hover:bg-white/80'
            : 'lg:pointer-fine:[&_button]:bg-white/60 lg:pointer-fine:[&_button]:hover:bg-white/80'),
        className
      )}
    >
      {children}
    </div>
  );
}
