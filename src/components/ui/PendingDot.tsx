import { cn } from '@/lib/cn';

/** The red dot on a label, icon or avatar, one look app-wide and still (Epo
 * 2026-11-13): unread notifications, something waiting on this person. The
 * caller places it (`absolute`) beside what it marks. */
export function PendingDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('absolute size-2 rounded-full bg-solid-error', className)}
    />
  );
}
