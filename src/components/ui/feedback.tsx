import { m } from '@/i18n';
import { cn } from '@/lib/cn';

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      aria-label={m.a11y_loading()}
      className={cn('isolate size-4.5 animate-spin leading-none', className)}
      data-slot="spinner"
      fill="none"
      role="status"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-button bg-surface-hover-bg',
        className
      )}
      style={style}
    />
  );
}

export function SkeletonCardGrid({
  count = 6,
  className,
  cardClassName,
  cardHeight = 150,
}: {
  count?: number;
  className?: string;
  cardClassName?: string;
  cardHeight?: number;
}) {
  return (
    <div
      aria-label={m.a11y_loading()}
      className={cn(
        'grid w-full grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4',
        className
      )}
      role="status"
    >
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          className={cn('rounded-card-lg', cardClassName)}
          key={i}
          style={{ height: cardHeight }}
        />
      ))}
    </div>
  );
}

export function SkeletonList({
  count = 5,
  className,
  rowClassName,
  rowHeight = 44,
}: {
  count?: number;
  className?: string;
  rowClassName?: string;
  rowHeight?: number;
}) {
  return (
    <div
      aria-label={m.a11y_loading()}
      className={cn('flex flex-col gap-2', className)}
      role="status"
    >
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          className={cn('rounded-button', rowClassName)}
          key={i}
          style={{ height: rowHeight }}
        />
      ))}
    </div>
  );
}
