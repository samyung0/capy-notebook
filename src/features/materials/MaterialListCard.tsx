import type { MaterialListItem } from '@/api/types';
import type { ListView } from '@/components/app/ListToolbar';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { materialIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';

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
  return format.format(0, 'minute');
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

/** The per-kind detail line: question count, card progress, or nothing. */
export function materialDetails(item: MaterialListItem): string {
  if (item.kind === 'quiz') {
    return [
      m.material_ref_questions({ count: item.questionCount ?? 0 }),
      item.timeLimitMin
        ? m.material_ref_minutes({ count: item.timeLimitMin })
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (item.kind === 'flashcards') {
    return [
      m.material_ref_cards({ count: item.cardCount ?? 0 }),
      m.material_ref_known({ pct: item.knownPct ?? 0 }),
    ].join(' · ');
  }
  return '';
}

function KindIcon({
  item,
  workspaceIconId,
  size = 'md',
}: {
  item: MaterialListItem;
  workspaceIconId?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-card bg-surface-hover-bg',
        size === 'md' ? 'size-10' : 'size-8'
      )}
    >
      <FileIcon
        className={size === 'md' ? 'size-5' : 'size-4'}
        name={materialIconName(item.kind)}
      />
      {workspaceIconId && (
        <img
          alt=""
          className="absolute -right-1.5 -bottom-1.5 size-4.5 rounded-[5px] bg-surface ring-2 ring-surface"
          height={18}
          src={iconUrl(workspaceIconId)}
          width={18}
        />
      )}
    </span>
  );
}

/** Where the item lives. Standalone items say nothing. */
function Location({ item }: { item: MaterialListItem }) {
  if (item.parentMaterialId) {
    return (
      <p className="flex min-w-0 items-center gap-1 text-fg-secondary text-xs">
        <Icon className="shrink-0 text-fg-muted" name="newNote" size={12} />
        <span className="truncate">
          {m.create_in_note({ title: item.parentTitle })}
        </span>
        {item.workspaceName && (
          <>
            <span className="text-fg-muted">›</span>
            <span className="truncate">{item.workspaceName}</span>
          </>
        )}
      </p>
    );
  }
  if (item.workspaceId) {
    return (
      <p className="flex min-w-0 items-center gap-1 text-fg-secondary text-xs">
        <Icon className="shrink-0 text-fg-muted" name="book" size={12} />
        <span className="truncate">{item.workspaceName}</span>
        {item.chapterName && (
          <>
            <span className="text-fg-muted">›</span>
            <span className="truncate">{item.chapterName}</span>
          </>
        )}
      </p>
    );
  }
  return null;
}

function Badges({ item }: { item: MaterialListItem }) {
  const due = item.kind === 'flashcards' && (item.dueCount ?? 0) > 0;
  const shared = item.privacy !== 'private';
  if (!due && !shared) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {due && (
        <Badge size="sm" tone="accent-1">
          {m.flashcards_due_count({ count: item.dueCount ?? 0 })}
        </Badge>
      )}
      {shared && (
        <Badge size="sm" tone={item.privacy === 'public' ? 'success' : 'info'}>
          {item.privacy === 'public'
            ? m.share_public()
            : m.workspace_privacy_shared()}
        </Badge>
      )}
    </div>
  );
}

export function MaterialCard({
  item,
  view,
  workspaceIconId,
  menu,
  onOpen,
}: {
  item: MaterialListItem;
  view: ListView;
  workspaceIconId?: string;
  menu: MenuItem[];
  onOpen: () => void;
}) {
  const details = materialDetails(item);
  const updated = relativeTime(item.updatedAt);
  if (view === 'list') {
    return (
      <div
        className="flex cursor-pointer flex-col gap-1 border-divider border-t px-4 py-2.5 hover:bg-surface-hover-bg md:grid md:grid-cols-[minmax(200px,2.4fr)_1.1fr_minmax(160px,2fr)_1.5fr_1fr_40px] md:items-center md:gap-3"
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onOpen();
        }}
        role="button"
        tabIndex={0}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <KindIcon item={item} size="sm" workspaceIconId={workspaceIconId} />
          <p className="truncate font-bold">{item.title}</p>
        </div>
        <div className="hidden md:block">
          <Badge size="sm">{materialKindLabel(item.kind)}</Badge>
        </div>
        <Location item={item} />
        <div className="flex items-center gap-2 text-fg-muted text-sm">
          {details}
          <Badges item={item} />
        </div>
        <p className="text-fg-muted text-sm">{updated}</p>
        <div className="justify-self-end" onClick={(e) => e.stopPropagation()}>
          <Menu items={menu} />
        </div>
      </div>
    );
  }
  return (
    <Card
      border="solid"
      className="relative flex h-full flex-col gap-2 p-3.5"
      interactive
      onClick={onOpen}
      radius="card-lg"
    >
      <div className="flex items-start justify-between">
        <KindIcon item={item} workspaceIconId={workspaceIconId} />
        <div onClick={(e) => e.stopPropagation()}>
          <Menu items={menu} />
        </div>
      </div>
      <p className="t-card-title mt-1 line-clamp-2">{item.title}</p>
      <Location item={item} />
      <p className="t-meta text-fg-muted">
        {details ? `${details} · ${updated}` : updated}
      </p>
      <div className="mt-auto">
        <Badges item={item} />
      </div>
    </Card>
  );
}
