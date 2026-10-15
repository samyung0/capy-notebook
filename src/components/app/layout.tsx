import { createContext, type ReactNode, type RefObject, useRef } from 'react';
import { useMediaQuery } from 'usehooks-ts';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { PhoneTopRow } from './Sidebar';
import { TopInsetBar } from './TopInsetBar';

/** The scrolling body of the page panel, the root that ListEnd watches. */
export const PanelScrollRoot = createContext<
  RefObject<HTMLDivElement | null> | undefined
>(undefined);

/**
 * Large page panel with the top bar in a notch at its top-right from xl.
 * Below xl there is no notch: the sidebar or rail carries search,
 * notifications and the profile, and on phones the panel opens with the
 * nav drawer's menu button.
 */
export function PanelWithInvertedRadius({
  children,
  header,
  className,
  sectionClassName,
}: {
  children: ReactNode;
  /** From xl it stays put above the scrolling body: it holds the top bar in
   * the notch, and content scrolling under the notch would show outside the
   * panel's shape. Below xl it scrolls with the body. */
  header?: ReactNode;
  sectionClassName?: string;
  scroll?: boolean;
  /** Placement in the parent layout, e.g. flex-1 in a row. */
  className?: string;
}) {
  // Below xl the header scrolls too, so the scroller is the wrapper of
  // header and body; from xl it is the body alone.
  const outerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const xl = useMediaQuery('(min-width: 1280px)');
  return (
    <div
      className={cn(
        'flex h-full min-h-0 w-full flex-col gap-1.5 sm:gap-2.5',
        className
      )}
    >
      <Card
        className="inverted-radius-large-panel-container min-h-0 w-full flex-1 p-0 shadow-card sm:rounded-card-xl"
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
            className="inverted-radius-large-panel absolute inset-0 block p-0 sm:rounded-card-xl"
            radius="button"
          >
            <div />
          </Card>
          <div className="relative flex h-full flex-col gap-2">
            <div
              className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto xl:overflow-visible"
              ref={outerRef}
            >
              <PhoneTopRow className="shrink-0 px-4 pt-3 pb-2" />
              {header && <div className="shrink-0">{header}</div>}
              <div
                className="flex flex-1 flex-col items-stretch gap-2 p-0 pb-10 xl:min-h-0 xl:overflow-auto"
                ref={bodyRef}
              >
                <PanelScrollRoot.Provider value={xl ? bodyRef : outerRef}>
                  {children}
                </PanelScrollRoot.Provider>
              </div>
            </div>
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
  scrollRef,
  as,
}: {
  children: ReactNode;
  className?: string;
  sectionClassName?: string;
  /** The scrolling element, e.g. an IntersectionObserver root. */
  scrollRef?: React.Ref<HTMLDivElement>;
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
          ref={scrollRef}
        >
          {children}
        </div>
      </El>
    </Card>
  );
}

/**
 * The title row of a side panel or drawer (the /qb topics panel, the theme
 * drawer): card title, with optional controls before it and after it. Sits
 * in a `px-2 py-5` panel section.
 */
export function PanelHeader({
  title,
  leading,
  actions,
}: {
  title: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1 px-4',
        leading && 'pl-2',
        actions && 'pr-2'
      )}
    >
      {leading}
      <h2 className="t-card-title mr-auto min-w-0 truncate">{title}</h2>
      {actions}
    </div>
  );
}

/**
 * General-page header: page title + actions on the left, the top-level inset
 * bar (search / notifications / profile) nested at the top-right from xl.
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
          'flex min-w-0 items-center gap-10 px-4 pt-2 pb-0 sm:px-6 sm:pt-6 sm:pb-2',
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
      {showTopBar && <TopInsetBar className="hidden xl:flex" />}
    </header>
  );
}
