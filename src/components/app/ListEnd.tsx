import type { FetchNextPageOptions } from '@tanstack/react-query';
import { useContext, useEffect, useRef } from 'react';
import { PanelScrollRoot } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useNear } from '@/lib/useNear';

/** Joins a page fetch in flight, e.g. Select all's, instead of restarting it. */
const joinFetch: FetchNextPageOptions = { cancelRefetch: false };

/**
 * The end of a paged list. The next page loads once this comes within 800px
 * of the page panel's bottom (the viewport outside a panel). A failed page
 * stops loading; Load more tries it again.
 */
export function ListEnd({
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError,
  fetchNextPage,
  className,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: (options?: FetchNextPageOptions) => Promise<unknown>;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const root = useContext(PanelScrollRoot);
  const near = useNear(ref, '0px 0px 800px 0px', root);
  // Also runs after each page lands, so a page too short to push this out of
  // range loads the next one.
  useEffect(() => {
    if (near && hasNextPage && !isFetchingNextPage && !isFetchNextPageError)
      void fetchNextPage(joinFetch);
  }, [
    near,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
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
