import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** The Study pages' padding: the boards' 28px 36px, the phone gutter below sm. */
export function PracticeFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    // One column leaves room under the page for the floating chat button.
    <div
      className={cn(
        'min-h-0 flex-1 overflow-auto px-4 pt-5 pb-24 sm:px-6 lg:px-9 lg:pt-7 lg:pb-10',
        className
      )}
    >
      {children}
    </div>
  );
}

export function Th({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <th
      className={cn(
        't-meta whitespace-nowrap border-divider border-b px-3 py-1.5 text-left align-bottom font-semibold text-fg-muted',
        className
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  muted,
}: {
  children?: ReactNode;
  className?: string;
  muted?: boolean;
}) {
  return (
    <td
      className={cn(
        'h-10 truncate border-divider border-b px-3',
        muted && 'font-semibold text-fg-muted',
        className
      )}
    >
      {children}
    </td>
  );
}
