import { Link, type LinkProps, useNavigate } from '@tanstack/react-router';
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useRef,
} from 'react';
import { Card } from '@/components/ui/Card';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { Skeleton } from '@/components/ui/feedback';
import type { PickContext } from '@/features/files/useFileSelection';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import type { ListView } from './ListToolbar';
import {
  ariaSort,
  type ColumnSort,
  SortHeader,
  sortDirection,
} from './SortHeader';
import { type Thumbnail, ThumbnailPanel } from './ThumbnailPanel';
import { WorkspaceCell } from './WorkspaceCell';

/** Grid card and list row shared by the Files, Blocks and Trash lists and the
 * Dashboard's recents.
 * Presentation only: the page owns navigation, actions and dialogs. */

/** The page's selection (useFileSelection's pickContext) for its pickable
 * items. With a mouse a click selects just that item, Cmd/Ctrl-click adds or
 * removes it, Shift-click picks a range and a double click opens; on touch a tap opens, a long press
 * selects, and while anything is selected a tap adds or removes. A context,
 * so a pick re-renders only the overlays, not every card. */
export const ItemPick = createContext<PickContext | null>(null);

const LONG_PRESS_MS = 450;
const PRESS_SLOP_PX = 10;

/** The pick-and-open button laid over a selectable item. */
function PickOverlay({
  pickKey,
  label,
  link,
  selected,
}: {
  pickKey: string;
  label: string;
  link?: LinkProps;
  selected: boolean;
}) {
  const selection = useContext(ItemPick);
  const navigate = useNavigate();
  const press = useRef<{
    timer?: number;
    x: number;
    y: number;
    held: boolean;
    touch: boolean;
  }>({ held: false, touch: false, x: 0, y: 0 });
  const open = () => {
    if (link) void navigate(link);
  };
  const release = () => window.clearTimeout(press.current.timer);
  return (
    <button
      aria-label={label}
      aria-pressed={selected}
      className="absolute inset-0 z-10 cursor-default select-none rounded-[inherit] [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
      disabled={selection?.busy}
      onClick={(event) => {
        const { held, touch } = press.current;
        press.current.held = false;
        if (touch) {
          if (held) return;
          if (selection?.active) selection.pick(pickKey, 'toggle');
          else open();
          return;
        }
        selection?.pick(
          pickKey,
          event.shiftKey
            ? 'range'
            : event.metaKey || event.ctrlKey
              ? 'toggle'
              : 'only'
        );
      }}
      onContextMenu={(event) => {
        if (press.current.touch) event.preventDefault();
      }}
      onDoubleClick={() => {
        if (!press.current.touch) open();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        open();
      }}
      onPointerCancel={release}
      onPointerDown={(event) => {
        release();
        const touch = event.pointerType === 'touch';
        press.current = {
          held: false,
          touch,
          x: event.clientX,
          y: event.clientY,
        };
        if (!touch) return;
        press.current.timer = window.setTimeout(() => {
          press.current.held = true;
          selection?.pick(pickKey, 'toggle');
        }, LONG_PRESS_MS);
      }}
      onPointerMove={(event) => {
        const { x, y } = press.current;
        if (Math.hypot(event.clientX - x, event.clientY - y) > PRESS_SLOP_PX)
          release();
      }}
      onPointerUp={release}
      type="button"
    />
  );
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
  pickKey,
  selected = false,
  thumbnail,
  dense = false,
}: {
  view: ListView;
  icon: FileIconName;
  title: string;
  /** The list's column; the grid card's bottom line, before `meta`. */
  workspace?: string;
  workspaceIconId?: string;
  /** Question or card count, file size. */
  details?: string;
  /** Updated, added or expiry line: the grid card's bottom line. */
  meta: string;
  /** Grid view only. */
  thumbnail?: Thumbnail;
  /** Grid view only: the dashboard's cards, with a shorter thumbnail. */
  dense?: boolean;
  link?: LinkProps;
  actions?: ReactNode;
  /** Makes the item pickable under an ItemPick provider (Files, Blocks,
   * Trash); the key the page's selection knows it by. */
  pickKey?: string;
  selected?: boolean;
}) {
  const pickable = pickKey !== undefined;
  const overlay = pickable && (
    <PickOverlay
      label={m.files_select_item({ name: title })}
      link={link}
      pickKey={pickKey}
      selected={selected}
    />
  );
  // A pickable item opens from its overlay, so its title is no link.
  const titleLink = pickable ? undefined : link;
  if (view === 'list') {
    return (
      <div
        className={cn(
          'relative flex flex-col gap-1 border-divider border-t px-4 py-2.5 text-sm hover:bg-surface-hover-bg md:grid md:grid-cols-[minmax(200px,2.4fr)_minmax(160px,2fr)_1.5fr_1fr_40px] md:items-center md:gap-3',
          selected && 'bg-tint-accent-1/60 hover:bg-tint-accent-1/60'
        )}
        data-item
      >
        {overlay}
        <div className="flex min-w-0 items-center gap-3.5">
          <FileIcon className="size-4 -translate-y-px" name={icon} />
          <Title
            className="truncate focus-visible:after:ring-inset"
            link={titleLink}
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
          {actions}
        </div>
      </div>
    );
  }
  // Drive's card: icon, title and ⋯ on top, the thumbnail, then the hint.
  // From `sm` one-line titles keep every card in a row the same height;
  // narrower cards wrap the title to two lines and drop the workspace.
  return (
    <Card
      border="solid"
      className={cn(
        '@container relative gap-0 p-1.5',
        selected &&
          'border-solid-accent-1 bg-tint-accent-1/60 hover:bg-tint-accent-1/60'
      )}
      data-item
      // A selectable card picks on click, so it shows no link affordance
      // (pointer, lift): a click must not look like it opens the file.
      interactive={!!link && !pickable}
    >
      {overlay}
      <div className="flex min-h-8.5 min-w-0 items-start gap-2 pt-1.5 pb-1.5 pl-1.5 sm:h-8.5 sm:items-center sm:pt-0">
        <FileIcon
          className="mt-px size-4 shrink-0 sm:mt-0 sm:-translate-y-px"
          name={icon}
        />
        <Title
          className="line-clamp-2 min-w-0 flex-1 break-words font-semibold @min-[200px]:text-[14.5px] text-[13.5px] leading-tight after:rounded-card sm:line-clamp-none sm:truncate"
          link={titleLink}
        >
          {title}
        </Title>
        {actions ? (
          <div className="relative z-10 -mt-1.5 shrink-0 sm:-my-0.5 [&_button]:p-1.5">
            {actions}
          </div>
        ) : null}
      </div>
      <ThumbnailPanel dense={dense} icon={icon} {...thumbnail} />
      {/* A fixed-height line, so cards with and without a workspace match;
          pinned to the bottom when a wrapped title makes a row taller. */}
      <div className="mt-auto box-content flex h-5 min-w-0 items-center gap-1.5 px-1.5 pt-2.5 pb-1 text-[13px] text-fg">
        {workspace && (
          <span className="hidden min-w-0 items-center gap-1.5 sm:flex">
            {workspaceIconId && (
              <img
                alt=""
                className="size-4 shrink-0 -translate-y-px rounded-[3px]"
                height={16}
                src={iconUrl(workspaceIconId)}
                width={16}
              />
            )}
            <span className="min-w-0 truncate font-semibold @min-[200px]:text-[14.5px] text-[13.5px] leading-tight">
              {workspace}
            </span>
            <span aria-hidden className="shrink-0">
              ·
            </span>
          </span>
        )}
        <span className="shrink-0 whitespace-nowrap text-fg-muted">{meta}</span>
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
        // Above the thumbnail (positioned, later in the card), under the ⋯.
        'after:absolute after:inset-0 after:z-1 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action'
      )}
    >
      {children}
    </Link>
  );
}

/** A list column's label, or a label that sorts the list by `sort`. */
export type ItemColumn<S extends string> = string | { label: string; sort: S };

/** Grid, or bordered list with a header row for the four text columns; the
 * fifth column holds the actions. With `sorting` the columns that name a
 * sort order the list from the header (only from md, where it shows). */
export function ItemList<S extends string = string>({
  view,
  columns,
  sorting,
  children,
}: {
  view: ListView;
  columns: [ItemColumn<S>, ItemColumn<S>, ItemColumn<S>, ItemColumn<S>];
  sorting?: ColumnSort<S>;
  children: ReactNode;
}) {
  if (view === 'grid') return <ItemGrid>{children}</ItemGrid>;
  return (
    <div className="overflow-hidden rounded-card border border-line">
      <div className="hidden bg-surface-hover-bg px-4 py-2.5 font-bold text-fg-muted text-xs uppercase tracking-wide md:grid md:grid-cols-[minmax(200px,2.4fr)_minmax(160px,2fr)_1.5fr_1fr_40px] md:items-center md:gap-3">
        {columns.map((column) =>
          typeof column === 'string' || !sorting ? (
            <div key={typeof column === 'string' ? column : column.label}>
              {typeof column === 'string' ? column : column.label}
            </div>
          ) : (
            <div
              aria-sort={ariaSort(sortDirection(sorting, column.sort))}
              className="min-w-0"
              key={column.label}
              role="columnheader"
            >
              <SortHeader
                label={column.label}
                sorting={sorting}
                value={column.sort}
              />
            </div>
          )
        )}
        <div />
      </div>
      {children}
    </div>
  );
}

/** The card grid: as many columns as fit at 140px (two on a 360px phone),
 * growing to 180px from `sm`, 210px from `lg` and 240px from `xl`; each card
 * at most 320px wide and centred in a column that grows past that. */
export function ItemGrid({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'grid w-full grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-4 lg:grid-cols-[repeat(auto-fill,minmax(210px,1fr))] xl:grid-cols-[repeat(auto-fill,minmax(240px,1fr))] [&>*]:w-full [&>*]:max-w-80 [&>*]:justify-self-center',
        className
      )}
      {...rest}
    />
  );
}

/** Loading cards the size of the real ones, so the grid does not shift
 * when rows arrive. */
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
          className="@container rounded-card border border-transparent p-1.5"
          key={i}
        >
          <div className="flex h-8.5 items-center gap-2 pb-1.5 pl-1.5">
            <Skeleton className="size-4 shrink-0" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
          <Skeleton
            className={cn(
              'rounded-[13px]',
              dense ? 'aspect-[16/10]' : 'aspect-[16/11]'
            )}
          />
          <div className="box-content flex h-5 items-center px-1.5 pt-2.5 pb-1">
            <Skeleton className="h-3.5 w-1/2" />
          </div>
        </div>
      ))}
    </ItemGrid>
  );
}
