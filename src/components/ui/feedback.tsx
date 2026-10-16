import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import './feedback.css';

/** Leapfrog dots in an 18px square; a size-* class resizes it. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-label={m.a11y_loading()}
      className={cn('spinner', className)}
      data-slot="spinner"
      role="status"
    >
      <i />
      <i />
      <i />
    </span>
  );
}

/** The loader over a message, centred in a file or editor pane. */
export function PaneLoading({ message }: { message: string }) {
  return (
    <div className="pane-loading">
      <Spinner />
      <p>{message}</p>
    </div>
  );
}

export function Skeleton({
  className,
  style,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  /** Invisible spacers that size the block like the content it stands for. */
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-button bg-surface-hover-bg [animation-timing-function:var(--motion-ease-linear)]',
        className
      )}
      style={style}
    >
      {children}
    </div>
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
