import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** One coloured share of a meter, as the Usage tab and the workspace Indexing
 * tab draw them. */
export interface Segment {
  /** Same unit as the meter's limit. */
  amount: number;
  color: string;
  faint?: boolean;
  key: string;
  label: string;
}

/** Track with one coloured segment per share of the limit; a 2px surface
 * gap separates neighbours. */
export function UsageBar({
  segments,
  limit,
}: {
  segments: Segment[];
  limit: number;
}) {
  return (
    <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface-hover-bg">
      {limit > 0 &&
        segments
          .filter((s) => s.amount > 0)
          .map((s) => (
            <div
              className={cn(
                'h-full shrink-0 shadow-[2px_0_0_var(--color-surface)]',
                s.faint && 'opacity-35'
              )}
              key={s.key}
              style={{
                backgroundColor: s.color,
                width: `${Math.min(100, (s.amount / limit) * 100)}%`,
              }}
            />
          ))}
    </div>
  );
}

export function UsageHead({
  title,
  value,
}: {
  title: string;
  value: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <p className="t-subtitle font-bold">{title}</p>
      <p className="t-subtitle font-bold">{value}</p>
    </div>
  );
}

/** Legend rows under a meter: swatch, label and a formatted value. */
export function UsageLegend({
  segments,
}: {
  segments: (Segment & { value: ReactNode })[];
}) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {segments.map((s) => (
        <li
          className="flex items-center justify-between gap-4 py-1.5"
          key={s.key}
        >
          <span className="flex items-center gap-3">
            <span
              className={cn(
                'size-2.5 shrink-0 rounded-[3px]',
                s.faint && 'opacity-35'
              )}
              style={{ backgroundColor: s.color }}
            />
            {s.label}
          </span>
          <span className="text-fg-muted">{s.value}</span>
        </li>
      ))}
    </ul>
  );
}
