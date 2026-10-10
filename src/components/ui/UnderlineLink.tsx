import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * An underlined text action with the forward arrow (Continue, Review,
 * Summary), so links don't outweigh the page; `accent` marks the page's main
 * one. `noArrow` drops the arrow in long lists of repeated actions.
 * `asChild` wraps a router Link.
 */
export function UnderlineLink({
  accent,
  noArrow,
  className,
  ...props
}: ComponentProps<typeof Button> & { accent?: boolean; noArrow?: boolean }) {
  return (
    <Button
      className={cn(
        'shrink-0 justify-self-end underline decoration-[1.5px] underline-offset-4',
        !accent && 'text-fg-secondary hover:text-fg',
        className
      )}
      iconRight={noArrow ? undefined : 'navigationForward'}
      size="xs"
      variant={accent ? 'ghost-link' : 'ghost'}
      {...props}
    />
  );
}
