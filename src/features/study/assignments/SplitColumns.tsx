import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Two columns from a tablet up, as an Assignment's Grading has them and an
 * upload's page reuses (Epo 2026-11-25): a side column, 300px and 360px from
 * lg, ruled off from the main one, each scrolling on its own, the side with
 * no scrollbar. Phones stack them. */
export function SplitColumns({
  children,
  className,
  mainClassName,
  side,
  sideClassName,
}: {
  children: ReactNode;
  className?: string;
  mainClassName?: string;
  side: ReactNode;
  sideClassName?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col md:grid md:min-h-0 md:grid-cols-[300px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] lg:grid-cols-[360px_minmax(0,1fr)]',
        className
      )}
    >
      <div
        className={cn(
          'md:min-h-0 md:overflow-y-auto md:overflow-x-hidden md:border-divider md:border-r md:[scrollbar-width:none] md:[&::-webkit-scrollbar]:hidden',
          sideClassName
        )}
      >
        {side}
      </div>
      <div className={cn('min-w-0 md:min-h-0', mainClassName)}>{children}</div>
    </div>
  );
}
