import type { ReactNode } from 'react';
import { InputTitle } from '@/components/ui/Input';
import { cn } from '@/lib/cn';

/** Body under a page's tabs, at the wide gutter (`page-px-wide`). It grows
 * with its content so the panel scrolls the header and tabs away with it.
 * Content stops at max-w-7xl unless `fill` (Learning and quiz pages run to
 * the gutter) or `narrow` (forms, whose inputs read badly that long). */
export function TabContent({
  children,
  centered,
  fill,
  narrow,
  pane,
}: {
  children: ReactNode;
  centered?: boolean;
  fill?: boolean;
  narrow?: boolean;
  /** In the workspace centre pane: page-px-wide's steps (and the sm top
   * padding) by the pane's own width rather than the window's. */
  pane?: boolean;
}) {
  const body = (
    <div
      className={cn(
        !fill && (narrow ? 'max-w-3xl' : 'max-w-7xl'),
        centered && 'mx-auto'
      )}
    >
      {children}
    </div>
  );
  if (pane)
    return (
      <div className="@container/pane relative flex-1">
        <div className="@min-[40rem]/pane:px-6 @min-[64rem]/pane:px-10 @min-[80rem]/pane:px-16 px-4 @min-[40rem]/pane:pt-8 pt-5 pb-8">
          {body}
        </div>
      </div>
    );
  return (
    <div className="page-px-wide relative flex-1 pt-5 pb-8 sm:pt-8">{body}</div>
  );
}

export function TabHeader({
  title,
  description,
  badge,
}: {
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-col gap-1">
      <div className="flex items-center gap-2.5">
        <h2 className="t-card-title">{title}</h2>
        {badge}
      </div>
      {description && <p className="text-fg-secondary">{description}</p>}
    </div>
  );
}

/** Heading for a group of rows inside a tab's row column; the column's gap
 * spaces it, so it carries no margin of its own. */
export function SectionTitle({ title }: { title: string }) {
  return <h3 className="t-card-title">{title}</h3>;
}

/** Groups irreversible SettingRows. The red border marks the group from sm;
 * phones drop it to keep the row width. */
export function DangerZone({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:rounded-card sm:border sm:border-solid-error/40 sm:p-4">
      {children}
    </div>
  );
}

/** Title and hint on the left, control on the right, as in the workspace
 * sharing dialog, phones included. A control too wide to share the line
 * (a full-width picker) wraps under the text. */
export function SettingRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 sm:flex-nowrap sm:gap-6">
      <div className="flex min-w-24 flex-1 basis-0 flex-col gap-1">
        <InputTitle>{title}</InputTitle>
        {hint && <p className="t-meta text-fg-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
