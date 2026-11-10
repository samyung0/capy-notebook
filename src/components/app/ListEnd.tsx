import type { FetchNextPageOptions } from '@tanstack/react-query';
import { type RefObject, useContext, useEffect, useRef, useState } from 'react';
import { PanelScrollRoot } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useNear } from '@/lib/useNear';

/** Joins a page fetch in flight, e.g. Select all's, instead of restarting it. */
const joinFetch: FetchNextPageOptions = { cancelRefetch: false };

/** `root` for a list inside a scroller of its own that is not handed over (a
 * dialog's body, a menu): its end is watched on the screen. */
export const ON_SCREEN: RefObject<Element | null> = { current: null };

/**
 * The end of a paged list. The next page loads once this comes within 800px
 * of the page panel's bottom (the viewport outside a panel), or of `root`'s
 * for a list that scrolls by itself. A failed page stops loading; Load more
 * tries it again.
 */
export function ListEnd({
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError,
  fetchNextPage,
  className,
  root: own,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: (options?: FetchNextPageOptions) => Promise<unknown>;
  className?: string;
  /** The list's own scroller where it is not the page panel's (a side panel),
   * or `ON_SCREEN`. */
  root?: RefObject<Element | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const panel = useContext(PanelScrollRoot);
  const root = own ?? panel;
  const near = useNear(ref, '0px 0px 800px 0px', root);
  const [asked, setAsked] = useState(0);
  // Also runs after each page lands, so a page too short to push this out of
  // range loads the next one. And after each ask ends: one made while the list
  // was being read again (a stored list as its page opens) joined that read
  // and asked for no page, so it is asked again.
  useEffect(() => {
    if (near && hasNextPage && !isFetchingNextPage && !isFetchNextPageError)
      void fetchNextPage(joinFetch).then(() => setAsked((count) => count + 1));
  }, [
    near,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
    asked,
  ]);

  // Always mounted: the observer attaches once, on mount.
  return (
    <div className={cn('flex justify-center', className)} ref={ref}>
      {hasNextPage ? (
        isFetchNextPageError && !isFetchingNextPage ? (
          <Button
            onClick={() => void fetchNextPage(joinFetch)}
            size="sm"
            variant="ghost-hover"
          >
            {m.list_load_more()}
          </Button>
        ) : (
          <Spinner
            className={cn('text-fg-muted', !isFetchingNextPage && 'invisible')}
          />
        )
      ) : null}
    </div>
  );
}
