import { Link, type LinkProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { FileSelectionMark } from '@/features/files/FileSelectionActions';
import { cn } from '@/lib/cn';
import type { ListView } from './ListToolbar';
import { type Thumbnail, ThumbnailPanel } from './ThumbnailPanel';

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
  details,
  meta,
  link,
  actions,
  selection,
  thumbnail,
}: {
  view: ListView;
  icon: FileIconName;
  title: string;
  /** List view only, like `details`. */
  workspace?: string;
  /** Question or card count, file size. */
  details?: string;
  /** Updated, added or expiry line: the grid card's one hint line. */
  meta: string;
  /** Grid view only. */
  thumbnail?: Thumbnail;
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
          'relative flex flex-col gap-1 border-divider border-t px-4 py-2.5 hover:bg-surface-hover-bg md:grid md:grid-cols-[minmax(200px,2.4fr)_minmax(160px,2fr)_1.5fr_1fr_40px] md:items-center md:gap-3',
          selected && 'bg-surface-hover-bg'
        )}
      >
        {overlay}
        <div className="flex min-w-0 items-center gap-3.5">
          {selection && <FileSelectionMark selected={selected} />}
          <FileIcon className="size-4 -translate-y-px" name={icon} />
          <Title
            className="truncate font-bold focus-visible:after:ring-inset"
            link={selection ? undefined : link}
          >
            {title}
          </Title>
        </div>
        <p className="t-meta truncate text-fg-secondary">{workspace}</p>
        <p className="t-meta text-fg-muted">{details}</p>
        <p className="t-meta text-fg-muted">{meta}</p>
        <div className="relative z-10 -my-2 flex justify-self-end">
          {!selection && actions}
        </div>
      </div>
    );
  }
  // Card A: the thumbnail on top, then the icon and title, then one hint
  // line. Below 200px wide (phones, the dashboard's two columns) the title
  // wraps to two lines and the spacing tightens.
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
      <ThumbnailPanel icon={icon} {...thumbnail} />
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center @min-[200px]:gap-x-[9px] gap-x-[7px] gap-y-px @min-[200px]:pt-2.5 pt-2 @min-[200px]:pr-[34px] pr-[30px] @min-[200px]:pb-2 pb-1.5 @min-[200px]:pl-2.5 pl-2">
        <FileIcon
          className="@min-[200px]:mt-0 mt-0.5 size-4 self-start @min-[200px]:self-center"
          name={icon}
        />
        <Title
          className="wrap-anywhere @min-[200px]:line-clamp-1 line-clamp-2 font-semibold @min-[200px]:text-[14.5px] text-[13.5px] leading-tight after:rounded-card"
          link={selection ? undefined : link}
        >
          {title}
        </Title>
        <p className="col-start-2 truncate text-fg-muted text-xs">{meta}</p>
      </div>
      {selection ? (
        <span className="absolute @min-[200px]:right-3.5 right-2.5 @min-[200px]:bottom-4 bottom-3">
          <FileSelectionMark selected={selected} />
        </span>
      ) : (
        actions && (
          <div className="absolute @min-[200px]:right-1.5 right-0.5 @min-[200px]:bottom-2 bottom-1 z-10">
            {actions}
          </div>
        )
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
  if (view === 'grid') {
    return (
      <div className="grid w-full grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] sm:gap-3">
        {children}
      </div>
    );
  }
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
