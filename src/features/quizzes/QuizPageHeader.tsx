import type { LinkOptions } from '@tanstack/react-router';
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
} from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/* The chrome of a quiz or flashcard page, apart from the quiz runner, so a
   flashcard page or a shared note does not download the quiz code with it. */

/** The panel around the page; its header stays put while the body scrolls. */
export type Frame = (props: {
  children: ReactNode;
  header?: ReactNode;
}) => ReactNode;
export const NoFrame: Frame = ({ children }) => children;

/** A breadcrumb segment; with a link it opens that page. */
export type Crumb = { label: string; link?: LinkOptions };

/** Draws a crumb's link: the app passes the router's Link (main.tsx). Shared
 * pages leave it out, since their crumbs never link, and so never download
 * the router. */
export const CrumbLinkContext = createContext<ComponentType<
  LinkOptions & { children: ReactNode; className?: string }
> | null>(null);

/** Back arrow and breadcrumb above the page title; `actions` sit on the title line. */
export function QuizPageHeader({
  className,
  onBack,
  trail,
  title,
  meta,
  byline,
  actions,
  topBar,
}: {
  className?: string;
  onBack?: () => void;
  trail: Crumb[];
  title: ReactNode;
  meta?: ReactNode;
  /** The owner on public pages, between the title and the meta line. */
  byline?: ReactNode;
  actions?: ReactNode;
  /** The app's top bar, which from lg sits in PanelWithInvertedRadius's notch
   * beside this header; public pages have their own header and pass none. */
  topBar?: ReactNode;
}) {
  const CrumbLink = useContext(CrumbLinkContext);
  return (
    <header className="flex items-start">
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-2 px-4 pt-4 sm:px-6 sm:pt-6 lg:px-10 xl:px-16',
          className
        )}
      >
        {(onBack || trail.length > 0) && (
          <div
            className={cn(
              'flex min-h-9 items-center',
              // Pulled left past the icon's padding, and from sm a further
              // 8px so arrow and text balance; phones keep the edge margin.
              onBack && '-ml-2 sm:-translate-x-2'
            )}
          >
            {onBack && (
              <IconButton
                className="rounded-input"
                icon="navigationBack"
                iconClassName="-translate-y-px"
                label={m.action_back()}
                onClick={onBack}
                size="sm"
                variant="ghost-hover"
              />
            )}
            <nav
              aria-label={m.quiz_breadcrumb()}
              className="t-meta flex min-w-0 items-center gap-1.5 text-fg-muted"
            >
              {trail.map((item, i) => (
                <span className="flex min-w-0 items-center gap-1.5" key={i}>
                  {i > 0 && <span aria-hidden>/</span>}
                  {item.link && CrumbLink ? (
                    <CrumbLink
                      {...item.link}
                      className={cn(
                        'truncate underline-offset-2 hover:text-fg hover:underline',
                        i === trail.length - 1 && 'text-fg-secondary'
                      )}
                    >
                      {item.label}
                    </CrumbLink>
                  ) : (
                    <span
                      className={cn(
                        'truncate',
                        i === trail.length - 1 && 'text-fg-secondary'
                      )}
                    >
                      {item.label}
                    </span>
                  )}
                </span>
              ))}
            </nav>
          </div>
        )}
        <div className="flow-root">
          {/* Floated and one title line tall (the title's type sets 1lh): the
              actions centre on the first line and the rest of the title wraps
              under them at full width. */}
          {actions && (
            <div className="t-page-title float-right ml-2 flex h-[1lh] items-center gap-0.5 sm:ml-3 sm:gap-2">
              {actions}
            </div>
          )}
          <h1 className="t-page-title break-words">{title}</h1>
        </div>
        {byline}
        {/* Under a byline the meta belongs to the content below, so it sits
            further from the owner than the owner from the title. */}
        {meta && (
          <p className={cn('t-meta text-fg-muted', byline ? 'mt-2' : '-mt-1')}>
            {meta}
          </p>
        )}
      </div>
      {topBar}
    </header>
  );
}
