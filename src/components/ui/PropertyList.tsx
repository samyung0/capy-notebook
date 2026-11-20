import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Label and value rows, the labels in one column: an item's properties, as
 * the Files page shows them, and Before you start. */
export function PropertyList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <dl className={cn('grid grid-cols-[auto_1fr] gap-x-6 gap-y-2', className)}>
      {children}
    </dl>
  );
}

export function PropertyRow({
  label,
  labelClassName = 'text-fg-secondary',
  value,
}: {
  label: string;
  labelClassName?: string;
  value: string;
}) {
  return (
    <>
      <dt className={labelClassName}>{label}</dt>
      <dd className="truncate">{value}</dd>
    </>
  );
}
