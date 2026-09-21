import { Link, type LinkProps } from '@tanstack/react-router';
import type { MaterialListItem } from '@/api/types';
import type { ListView } from '@/components/app/ListToolbar';
import { Card } from '@/components/ui/Card';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { materialIconName } from '@/lib/fileIcons';

/** Grid card and list row of the Create page. Presentation only: the page
 * owns navigation, the action menu and every dialog. */

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
  for (const [unit, ms] of RELATIVE_STEPS) {
    if (Math.abs(diff) >= ms) return format.format(Math.round(diff / ms), unit);
  }
  return format.format(-1, 'minute');
}

export function materialKindLabel(kind: MaterialListItem['kind']): string {
  switch (kind) {
    case 'quiz':
      return m.editor_quiz();
    case 'flashcards':
      return m.editor_flashcards();
    default:
      return m.create_kind_note();
  }
}

/** The per-kind detail line: question or card count, or nothing. */
export function materialDetails(item: MaterialListItem): string {
  if (item.kind === 'quiz') {
    return m.material_ref_questions({ count: item.questionCount ?? 0 });
  }
  if (item.kind === 'flashcards') {
    return m.material_ref_cards({ count: item.cardCount ?? 0 });
  }
  return '';
}

function KindIcon({
  item,
  size = 'md',
  className,
}: {
  item: MaterialListItem;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <FileIcon
      className={cn(`${size === 'md' ? 'size-5' : 'size-4'}`, className)}
      name={materialIconName(item.kind)}
    />
  );
}

function Workspace({
  item,
  icon = false,
  details,
  className,
}: {
  item: MaterialListItem;
  icon?: boolean;
  details?: string;
  className?: string;
}) {
  if (!item.workspaceId) return null;
  return (
    <p
      className={cn(
        't-meta mt-0.5 flex min-w-0 items-center gap-1 text-fg-secondary',
        className
      )}
    >
      {icon && (
        <Icon
          className="shrink-0 -translate-y-px text-fg-muted"
          name="workspaces"
          size={12}
        />
      )}
      <span className="truncate">
        {item.workspaceName}
        {details ? ` · ${details}` : ''}
      </span>
    </p>
  );
}

export function MaterialCard({
  item,
  view,
  menu,
  link,
}: {
  item: MaterialListItem;
  view: ListView;
  menu: MenuItem[];
  link: LinkProps;
}) {
  const details = materialDetails(item);
  const updated = relativeTime(item.updatedAt);
  if (view === 'list') {
    return (
      <div className="relative flex flex-col gap-1 border-divider border-t px-4 py-2.5 hover:bg-surface-hover-bg md:grid md:grid-cols-[minmax(200px,2.4fr)_minmax(160px,2fr)_1.5fr_1fr_40px] md:items-center md:gap-3">
        <div className="flex min-w-0 items-center gap-3.5">
          <KindIcon className="-translate-y-px" item={item} size="sm" />
          <Link
            {...link}
            className="truncate font-bold after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset"
          >
            {item.title}
          </Link>
        </div>
        <Workspace item={item} />
        <p className="t-meta text-fg-muted">{details}</p>
        <p className="t-meta text-fg-muted">{updated}</p>
        <div className="relative z-10 flex justify-self-end">
          <Menu iconContainerClassName="p-0 size-fit" items={menu} />
        </div>
      </div>
    );
  }
  return (
    <Card
      border="solid"
      className="relative gap-3 p-4 leading-tight xl:px-5"
      interactive
    >
      <div className="flex items-center justify-between">
        <KindIcon item={item} />
        <div className="absolute top-2 right-2 z-50">
          <Menu items={menu} />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <Link
          {...link}
          className="t-body line-clamp-2 font-semibold after:absolute after:inset-0 after:rounded-card focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action"
        >
          {item.title}
        </Link>
        <Workspace className="text-xs" details={details} item={item} />
        <p className="text-fg-muted text-xs">{updated}</p>
      </div>
    </Card>
  );
}
