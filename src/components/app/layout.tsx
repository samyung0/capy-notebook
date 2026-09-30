import { createContext, type ReactNode, useContext } from 'react';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { TopInsetBar } from './TopInsetBar';

/** Set inside PanelWithInvertedRadius, which already shows the top bar above
 * the panel below lg; the header then keeps its own copy for lg and up. */
const TopBarAbovePanel = createContext(false);

/**
 * Large page panel with the top bar in a notch at its top-right from lg.
 * Below lg the notch goes away and the top bar sits above the panel, as on
 * the dashboard.
 */
export function PanelWithInvertedRadius({
  children,
  className,
  sectionClassName,
  topBar = <TopInsetBar />,
}: {
  children: ReactNode;
  sectionClassName?: string;
  scroll?: boolean;
  /** Placement in the parent layout, e.g. flex-1 in a row. */
  className?: string;
  /** Shown above the panel below lg; pass null for none. */
  topBar?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex h-full min-h-0 w-full flex-col gap-1.5 sm:gap-2.5',
        className
      )}
    >
      {topBar && <div className="shrink-0 lg:hidden">{topBar}</div>}
      <Card
        className="inverted-radius-large-panel-container min-h-0 w-full flex-1 p-0 shadow-card lg:rounded-card-xl"
        radius="button"
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
            className="inverted-radius-large-panel absolute inset-0 block p-0 lg:rounded-card-xl"
            radius="button"
          >
            <div />
          </Card>
          <div className="relative flex h-full flex-col items-stretch gap-2 overflow-auto p-0">
            <TopBarAbovePanel.Provider value={Boolean(topBar)}>
              {children}
            </TopBarAbovePanel.Provider>
          </div>
        </section>
      </Card>
    </div>
  );
}
export function Panel({
  children,
  className,
  sectionClassName,
  as,
}: {
  children: ReactNode;
  className?: string;
  sectionClassName?: string;
  scroll?: boolean;
  as?: React.ElementType;
}) {
  const El = as || 'section';
  return (
    <Card
      asChild
      className={cn('h-full overflow-hidden p-0 shadow-card', className)}
      radius="card-xl"
    >
      <El>
        <div
          className={cn(
            'flex max-h-full flex-col items-stretch gap-2 overflow-auto p-0',
            sectionClassName
          )}
        >
          {children}
        </div>
      </El>
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
  const barAbove = useContext(TopBarAbovePanel);
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
          {subtitle && <p className="mt-1 text-fg-secondary">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {showTopBar && (
        <TopInsetBar className={cn(barAbove && 'hidden lg:flex')} />
      )}
    </header>
  );
}
