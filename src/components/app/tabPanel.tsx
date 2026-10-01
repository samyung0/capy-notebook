import type { ReactNode } from 'react';
import { InputTitle } from '@/components/ui/Input';
import { cn } from '@/lib/cn';

/** Scrolling body under a page's tabs. Positioned descendants stay inside this
 * scroll area; padding grows with the screen. */
export function TabContent({
  children,
  centered,
}: {
  children: ReactNode;
  centered?: boolean;
}) {
  return (
    <div className="relative min-h-0 flex-1 overflow-auto px-4 pt-8 pb-8 sm:px-6 lg:px-10 xl:px-16">
      <div className={cn('max-w-3xl', centered && 'mx-auto')}>{children}</div>
    </div>
  );
}

export function TabHeader({
  title,
  description,
  badge,
}: {
  title: string;
  description: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-col gap-1">
      <div className="flex items-center gap-2.5">
        <h2 className="t-card-title">{title}</h2>
        {badge}
      </div>
      <p className="text-fg-secondary">{description}</p>
    </div>
  );
}

/** Title and hint on the left, control on the right, as in the workspace
 * sharing dialog. Stacks on phones so wide controls keep their width. */
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
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <InputTitle>{title}</InputTitle>
        {hint && <p className="t-meta text-fg-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
