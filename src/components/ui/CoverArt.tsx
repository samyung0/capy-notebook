import { useMemo } from 'react';
import type { CoverConfig } from '@/api/types';
import { cn } from '@/lib/cn';
import { type CoverPaint, coverPaint } from '@/lib/coverArt';

/** Memoised art for a cover; the owner's id seeds it unless the cover has a seed. */
export const useCoverPaint = (
  ownerId: string,
  label: string,
  cover: CoverConfig
) => useMemo(() => coverPaint(ownerId, label, cover), [ownerId, label, cover]);

export const coverBackground = (paint: CoverPaint) => ({
  backgroundColor: paint.color,
  backgroundImage: paint.image,
  backgroundPosition: paint.right ? 'right center' : 'center',
  backgroundSize: paint.repeat ? 'auto' : 'cover',
});

/**
 * A cover's art filling its positioned parent. `strip` adds the bottom shade
 * busy art needs under a one-line label; `card` washes the whole cover so a
 * card's name, counts and tags stay readable anywhere on it. Covers look the
 * same in every theme, so text over them follows `paint.light`, not tokens.
 */
export function CoverArt({
  paint,
  shade = 'strip',
  className,
}: {
  paint: CoverPaint;
  shade?: 'strip' | 'card';
  className?: string;
}) {
  return (
    <>
      <span
        aria-hidden
        className={cn('absolute inset-0', className)}
        style={coverBackground(paint)}
      />
      {shade === 'strip' && paint.shade && (
        <span
          aria-hidden
          className="absolute inset-0 bg-linear-to-t from-black/50 to-80% to-transparent"
        />
      )}
      {shade === 'card' && (
        <span
          aria-hidden
          className={cn(
            'absolute inset-0 bg-linear-to-b',
            paint.light
              ? 'from-white/55 to-white/25'
              : 'from-black/55 to-black/35'
          )}
        />
      )}
    </>
  );
}
