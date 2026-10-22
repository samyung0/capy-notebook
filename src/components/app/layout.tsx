import {
  type ComponentProps,
  createContext,
  type ReactNode,
  type RefObject,
  useRef,
} from 'react';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { PhoneTopRow } from './Sidebar';

/** The scrolling body of the page panel, the root that ListEnd watches. */
export const PanelScrollRoot = createContext<
  RefObject<HTMLDivElement | null> | undefined
>(undefined);

/**
 * The large page panel: an optional header and the body, scrolling together.
 * On phones it opens with the nav drawer's menu button and the profile menu.
 */
export function PagePanel({
  children,
  header,
  className,
  sectionClassName,
}: {
  children: ReactNode;
  header?: ReactNode;
  sectionClassName?: string;
  /** Placement in the parent layout, e.g. flex-1 in a row. */
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className={cn('flex h-full min-h-0 w-full flex-col', className)}>
      {/* The card clips, so the scrollbar follows its rounded corners. */}
      <Card
        className="min-h-0 w-full flex-1 overflow-hidden p-0 shadow-card sm:rounded-card-xl"
        radius="button"
      >
        <section className={cn('relative h-full max-w-full', sectionClassName)}>
          {/* The scroller keeps the scrollbar's gutter, so content that grows
              past the panel does not narrow it (and reflow grids). */}
          <div
            className="flex h-full min-h-0 flex-col gap-2 overflow-auto [scrollbar-gutter:stable]"
            ref={scrollRef}
          >
            <PhoneTopRow className="shrink-0 px-4 pt-3 pb-2" />
            {header && <div className="shrink-0">{header}</div>}
            <div className="flex flex-1 flex-col items-stretch gap-2 p-0 pb-10">
              <PanelScrollRoot.Provider value={scrollRef}>
                {children}
              </PanelScrollRoot.Provider>
            </div>
          </div>
        </section>
      </Card>
    </div>
  );
}
/**
 * Body of a page without tabs (Dashboard, Workspaces, Files, the Learning
 * tables): the normal gutter (`page-px`), 20/24px under the header. A list
 * page's ListToolbar already spaces the list from the header, so
 * `belowToolbar` keeps only a small gap. For the body under a page's tabs see
 * TabContent.
 */
export function PageBody({
  belowToolbar,
  className,
  ...props
}: ComponentProps<'div'> & { belowToolbar?: boolean }) {
  return (
    <div
      className={cn(
        'page-px w-full shrink-0 grow pb-6',
        belowToolbar ? 'pt-2' : 'pt-5 sm:pt-6',
        className
      )}
      {...props}
    />
  );
}

export function Panel({
  children,
  className,
  sectionClassName,
  scrollRef,
  as,
  frosted,
}: {
  children: ReactNode;
  className?: string;
  sectionClassName?: string;
  /** Frosted over the page frame's paint, like the shell's sidebar. */
  frosted?: boolean;
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
      data-frosted={frosted || undefined}
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

/** General-page header: page title, subtitle and actions. */
export function PageHeader({
  title,
  subtitle,
  actions,
  titleClassName,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  titleClassName?: string;
  className?: string;
}) {
  return (
    <header>
      <div
        className={cn(
          'page-px flex min-w-0 items-center gap-10 pt-2 pb-0 sm:pt-6 sm:pb-2',
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
    </header>
  );
}
