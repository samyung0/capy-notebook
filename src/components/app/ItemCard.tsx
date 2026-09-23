import { Link, type LinkProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { FileSelectionMark } from '@/features/files/FileSelectionActions';
import { cn } from '@/lib/cn';
import type { ListView } from './ListToolbar';

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
}: {
  view: ListView;
  icon: FileIconName;
  title: string;
  workspace?: string;
  /** Question or card count, file size. */
  details?: string;
  /** Updated, added or expiry line. */
  meta: string;
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
  const secondary = [workspace, details].filter(Boolean).join(' · ');
  return (
    <Card
      border="solid"
      className={cn(
        'relative gap-3 p-4 leading-tight xl:px-5',
        selected && 'ring-2 ring-accent'
      )}
      interactive={!!link || !!selection}
    >
      {overlay}
      <FileIcon className="size-5" name={icon} />
      {selection ? (
        <span className="absolute top-3 right-3">
          <FileSelectionMark selected={selected} />
        </span>
      ) : (
        actions && <div className="absolute top-2 right-2 z-10">{actions}</div>
      )}
      <div className="flex flex-1 flex-col gap-1">
        <Title
          className="t-body line-clamp-2 font-semibold after:rounded-card"
          link={selection ? undefined : link}
        >
          {title}
        </Title>
        {secondary && (
          <p className="t-meta mt-0.5 truncate text-fg-secondary text-xs">
            {secondary}
          </p>
        )}
        <p className="text-fg-muted text-xs">{meta}</p>
      </div>
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
      <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,250px),1fr))] gap-3">
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
