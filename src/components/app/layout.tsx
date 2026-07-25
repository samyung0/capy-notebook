import type { ReactNode } from 'react';
import { Card } from '@/components/ui';
import { cn } from '@/lib/cn';
import { TopInsetBar } from './TopInsetBar';

export function PanelWithInvertedRadius({
  children,
  className,
  sectionClassName,
}: {
  children: ReactNode;
  className?: string;
  sectionClassName?: string;
  scroll?: boolean;
}) {
  return (
    <Card
      className={cn(
        'inverted-radius-large-panel-container h-full w-full p-0 shadow-card',
        className
      )}
      radius="card-xl"
      theme="transparent"
    >
      <section
        className={cn(
          'relative h-full max-w-full overflow-hidden',
          sectionClassName
        )}
      >
        <Card
          asChild
          className={cn(
            'inverted-radius-large-panel absolute inset-0 block p-0',
            className
          )}
          radius="card-xl"
          theme="light"
        >
          <div />
        </Card>
        <div className="relative flex h-full flex-col items-stretch gap-2 overflow-auto p-0">
          {children}
        </div>
      </section>
    </Card>
  );
}
export function Panel({
  children,
  className,
  sectionClassName,
}: {
  children: ReactNode;
  className?: string;
  sectionClassName?: string;
  scroll?: boolean;
}) {
  return (
    <Card
      asChild
      className={cn('h-full overflow-hidden p-0 shadow-card', className)}
      radius="card-xl"
      theme="light"
    >
      <section>
        <div
          className={cn(
            'flex max-h-full flex-col items-stretch gap-2 overflow-auto p-0',
            sectionClassName
          )}
        >
          {children}
        </div>
      </section>
    </Card>
  );
}

/**
 * General-page header: page title + actions on the left, the top-level inset
 * bar (search / notifications / profile) nested at the top-right.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  showTopBar = true,
  titleClassName,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  showTopBar?: boolean;
  titleClassName?: string;
  className?: string;
}) {
  return (
    <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
      <div
        className={cn(
          'flex min-w-0 items-center gap-10 px-6 pt-6 pb-2',
          className
        )}
      >
        <div className={cn('min-w-0 translate-y-px', titleClassName)}>
          {typeof title === 'string' ? (
            <h1 className="t-page-title">{title}</h1>
          ) : (
            title
          )}
          {subtitle && (
            <p className="t-body mt-1 text-fg-secondary">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {showTopBar && <TopInsetBar />}
    </header>
  );
}

/** Sort/filter control cluster shared by Workspaces, Quizzes, Schedule. */
export function Toolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>{children}</div>
  );
}
