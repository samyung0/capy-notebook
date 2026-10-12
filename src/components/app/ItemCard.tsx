import { Link, type LinkProps } from '@tanstack/react-router';
import type { ComponentProps, ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { Skeleton } from '@/components/ui/feedback';
import { FileSelectionMark } from '@/features/files/FileSelectionActions';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { ListView } from './ListToolbar';
import { type Thumbnail, ThumbnailPanel } from './ThumbnailPanel';
import { WorkspaceCell } from './WorkspaceCell';

/** Grid card and list row shared by the Create, Files and Trash pages.
 * Presentation only: the page owns navigation, actions and dialogs. */

/** Present while the page is in selection mode; replaces the link and the
 * actions with a toggle. */
export interface ItemSelection {
  busy: boolean;
  label: string;
  onToggle: () => void;
  selected: boolean;
}

export function ItemCard({
  view,
  icon,
  title,
  workspace,
  workspaceIconId,
  details,
  meta,
  link,
  actions,
  selection,
  thumbnail,
  dense = false,
}: {
  view: ListView;
  icon: FileIconName;
  title: string;
  /** List view only, like `details`. */
  workspace?: string;
  workspaceIconId?: string;
  /** Question or card count, file size. */
  details?: string;
  /** Updated, added or expiry line: the grid card's one hint line. */
  meta: string;
  /** Grid view only. */
  thumbnail?: Thumbnail;
  /** Grid view only: the dashboard's narrow column, with one-line titles
   * and a shorter thumbnail. */
  dense?: boolean;
  link?: LinkProps;
  actions?: ReactNode;
  selection?: ItemSelection;
}) {
  const selected = !!selection?.selected;
  const overlay = selection && (
    <button
      aria-label={selection.label}
      aria-pressed={selection.selected}
      className="absolute inset-0 z-10 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
      disabled={selection.busy}
      onClick={selection.onToggle}
      type="button"
    />
  );
  if (view === 'list') {
    return (
      <div
        className={cn(
          'relative flex flex-col gap-1 border-divider border-t px-4 py-2.5 text-sm hover:bg-surface-hover-bg md:grid md:grid-cols-[minmax(200px,2.4fr)_minmax(160px,2fr)_1.5fr_1fr_40px] md:items-center md:gap-3',
          selected && 'bg-surface-hover-bg'
        )}
      >
        {overlay}
        <div className="flex min-w-0 items-center gap-3.5">
          {selection && <FileSelectionMark selected={selected} />}
          <FileIcon className="size-4 -translate-y-px" name={icon} />
          <Title
            className="truncate focus-visible:after:ring-inset"
            link={selection ? undefined : link}
          >
            {title}
          </Title>
        </div>
        <div className="min-w-0">
          {workspace && (
            <WorkspaceCell iconId={workspaceIconId} name={workspace} />
          )}
        </div>
        <p>{details}</p>
        <p>{meta}</p>
        <div className="relative z-10 -my-2 flex justify-self-end">
          {!selection && actions}
        </div>
      </div>
    );
  }
  // Card A: the thumbnail on top, then the icon and title, then one hint
  // line beside the actions, so the title gets the full width. One-line
  // titles cut mid-word; below 200px wide (phones, the dashboard's two
  // columns) non-dense titles wrap to two lines and the spacing tightens.
  return (
    <Card
      border="solid"
      className={cn(
        '@container relative gap-0 p-1.5',
        selected && 'ring-2 ring-accent'
      )}
      interactive={!!link || !!selection}
    >
      {overlay}
      <ThumbnailPanel dense={dense} icon={icon} {...thumbnail} />
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center @min-[200px]:gap-x-[9px] gap-x-[7px] gap-y-px @min-[200px]:px-2.5 px-2 @min-[200px]:pt-2.5 pt-2 @min-[200px]:pb-2 pb-1.5">
        <FileIcon
          className={cn(
            'size-4',
            !dense &&
              '@min-[200px]:mt-0 mt-0.5 self-start @min-[200px]:self-center'
          )}
          name={icon}
        />
        <Title
          className={cn(
            'wrap-anywhere font-semibold @min-[200px]:text-[14.5px] text-[13.5px] leading-tight after:rounded-card',
            dense ? 'truncate' : 'line-clamp-2 @min-[200px]:truncate'
          )}
          link={selection ? undefined : link}
        >
          {title}
        </Title>
        {/* The actions sit on the hint line, so they line up with it even
            when a neighbour's longer title stretches the card. A tighter
            button whose hover fill feathers out keeps off the title. */}
        <div className="relative col-start-2 min-w-0">
          <p className="truncate @min-[200px]:pr-[26px] pr-[22px] text-fg-muted text-xs">
            {meta}
          </p>
          {!selection && actions && (
            <div className="absolute top-1/2 -right-1 @min-[200px]:-right-0.5 z-10 -translate-y-[calc(50%+1px)] [&_button:hover]:shadow-[0_0_6px_3px_var(--color-surface-hover-bg)] [&_button]:p-1.5">
              {actions}
            </div>
          )}
        </div>
      </div>
      {selection && (
        <span className="absolute @min-[200px]:right-3.5 right-2.5 @min-[200px]:bottom-4 bottom-3">
          <FileSelectionMark selected={selected} />
        </span>
      )}
    </Card>
  );
}

/** The link stretches over the whole card through its ::after. */
function Title({
  link,
  className,
  children,
}: {
  link?: LinkProps;
  className: string;
  children: string;
}) {
  if (!link) return <p className={className}>{children}</p>;
  return (
    <Link
      {...link}
      className={cn(
        className,
        'after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action'
      )}
    >
      {children}
    </Link>
  );
}

/** Grid, or bordered list with a header row for the four text columns; the
 * fifth column holds the actions. */
export function ItemList({
  view,
  columns,
  children,
}: {
  view: ListView;
  columns: [string, string, string, string];
  children: ReactNode;
}) {
  if (view === 'grid') return <ItemGrid>{children}</ItemGrid>;
  return (
    <div className="overflow-hidden rounded-card border border-line">
      <div className="hidden bg-surface-hover-bg px-4 py-2.5 font-bold text-fg-muted text-xs uppercase tracking-wide md:grid md:grid-cols-[minmax(200px,2.4fr)_minmax(160px,2fr)_1.5fr_1fr_40px] md:gap-3">
        {columns.map((label) => (
          <div key={label}>{label}</div>
        ))}
        <div />
      </div>
      {children}
    </div>
  );
}

/** Card A's grid: two columns on phones, 180px columns from `sm`. */
function ItemGrid({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'grid w-full grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-3',
        className
      )}
      {...rest}
    />
  );
}

/** Loading cards the size of card A, so the grid does not shift when rows
 * arrive. The title bar takes two lines below 200px wide, as titles wrap
 * there, except on `dense` cards. */
export function ItemSkeletonGrid({
  count,
  className,
  dense = false,
}: {
  count: number;
  className?: string;
  dense?: boolean;
}) {
  return (
    <ItemGrid aria-label={m.a11y_loading()} className={className} role="status">
      {Array.from({ length: count }, (_, i) => (
        <div
          className="@container rounded-card border border-line bg-surface p-1.5"
          key={i}
        >
          <Skeleton
            className={cn(
              'rounded-[13px]',
              dense ? 'aspect-[16/10]' : 'aspect-[16/11]'
            )}
          />
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center @min-[200px]:gap-x-[9px] gap-x-[7px] gap-y-px @min-[200px]:px-2.5 px-2 @min-[200px]:pt-2.5 pt-2 @min-[200px]:pb-2 pb-1.5">
            <Skeleton
              className={cn(
                'size-4',
                !dense &&
                  '@min-[200px]:mt-0 mt-0.5 self-start @min-[200px]:self-center'
              )}
            />
            <Skeleton
              className={cn(
                '@min-[200px]:text-[14.5px] text-[13.5px] leading-tight',
                dense ? 'h-[1lh]' : '@min-[200px]:h-[1lh] h-[2lh]'
              )}
            />
            <Skeleton className="col-start-2 h-[1lh] w-1/2 text-xs" />
          </div>
        </div>
      ))}
    </ItemGrid>
  );
}
