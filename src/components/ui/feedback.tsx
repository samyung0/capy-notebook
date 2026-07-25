import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from './Icon';

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      aria-label="Loading"
      className={cn('size-4.5 animate-spin', className)}
      data-slot="spinner"
      fill="none"
      height="24"
      role="status"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="24"
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
      className={cn('animate-pulse rounded-row bg-surface-hover-bg', className)}
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
      aria-label="Loading"
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
      aria-label="Loading"
      className={cn('flex flex-col gap-2', className)}
      role="status"
    >
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          className={cn('rounded-row', rowClassName)}
          key={i}
          style={{ height: rowHeight }}
        />
      ))}
    </div>
  );
}

export function EmptyState({
  icon = 'fileError',
  title,
  body,
  action,
  className,
}: {
  icon?: IconName;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className
      )}
    >
      <div className="">
        <Icon className="size-7" name={icon} />
      </div>
      <h3 className="t-card-title">{title}</h3>
      {body && <p className="max-w-sm">{body}</p>}
      {action}
    </div>
  );
}
