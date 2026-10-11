import { Link, type LinkOptions, linkOptions } from '@tanstack/react-router';
import type { ReactNode } from 'react';
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

/** A block's first crumb: its workspace, or the Blocks tab when standalone. */
export const blockHomeCrumb = (block: {
  workspaceId: string;
  workspaceName: string;
}): Crumb =>
  block.workspaceId && block.workspaceName
    ? {
        label: block.workspaceName,
        link: linkOptions({
          params: { workspaceId: block.workspaceId },
          to: '/workspaces/$workspaceId',
        }),
      }
    : {
        label: m.files_tab_blocks(),
        link: linkOptions({ search: { tab: 'blocks' }, to: '/files' }),
      };

/** The Blocks tab filtered to one kind, e.g. every quiz. */
export const blockKindCrumb = (
  label: string,
  kind: 'quiz' | 'flashcards'
): Crumb => ({
  label,
  link: linkOptions({ search: { kind, tab: 'blocks' }, to: '/files' }),
});

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
                  {item.link ? (
                    <Link
                      {...item.link}
                      className={cn(
                        'truncate underline-offset-2 hover:text-fg hover:underline',
                        i === trail.length - 1 && 'text-fg-secondary'
                      )}
                    >
                      {item.label}
                    </Link>
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
        <div className="flex items-center justify-between gap-3">
          <h1 className="t-page-title min-w-0 truncate">{title}</h1>
          {actions && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
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
