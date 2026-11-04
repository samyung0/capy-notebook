import { Link, useNavigate } from '@tanstack/react-router';
import { Fragment, type ReactNode } from 'react';
import {
  usePractice,
  useWorkspaceDashboard,
  useWorkspaceRecent,
} from '@/api/hooks';
import type { Workspace, WorkspaceActivity } from '@/api/types';
import { PreviewCard } from '@/components/app/PreviewCard';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { recentIcon, recentThumbnail } from '@/features/home/RecentItemsCard';
import { mergeRecentItems, type RecentItem } from '@/features/home/recentItems';
import { SuggestedList } from '@/features/study/practice/SuggestedList';
import { studyView } from '@/features/study/practice/studyView';
import { getLocale, m } from '@/i18n';
import { isWorkspaceReadOnly } from './access';
import { HiddenMark } from './HiddenChip';

/** How many recent files the Dashboard shows (boards H1, H2: one row of four). */
const RECENT = 4;

/** The workspace's front page (Epo 2026-11-02, boards H1 owner, H2 member):
 * its name with the owner and member count, Upload and Make a quiz from a
 * file for those who may add, What to practise next for whoever practises here
 * (board U3), then Recent files and Activity. To do, assignments and AI marks
 * wait for their pages: with nothing in it, a section is not shown (Epo
 * 2026-11-02). */
export function WorkspaceDashboard({
  onUpload,
  workspace,
}: {
  onUpload: () => void;
  workspace: Pick<Workspace, 'capabilities' | 'id' | 'kind' | 'name' | 'role'>;
}) {
  const { data } = useWorkspaceDashboard(workspace.id);
  const { data: recent } = useWorkspaceRecent(workspace.id);
  const practises = !studyView(workspace).manages;
  const { data: practice } = usePractice(workspace.id, {
    enabled: practises,
    errorBoundary: false,
  });
  const navigate = useNavigate();
  const items = mergeRecentItems(
    recent?.files ?? [],
    recent?.materials ?? [],
    [],
    RECENT
  );
  const canAdd = !isWorkspaceReadOnly(workspace.capabilities);
  const meta = data
    ? [
        data.ownerName,
        data.members === 1
          ? m.workspace_members_one()
          : m.workspace_members_count({ count: data.members }),
      ].join(' · ')
    : '';

  return (
    // One column leaves room under the page for the floating chat button.
    <div className="flex min-h-0 flex-1 flex-col gap-6.5 overflow-auto px-4 pt-5 pb-24 sm:px-6 lg:px-9 lg:pt-7 lg:pb-10">
      {/* Spread apart on one line; wrapped, the actions start their own
          line at the left. */}
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="t-page-title truncate">{workspace.name}</h1>
          <span className="t-meta min-h-[1lh] text-fg-muted">{meta}</span>
        </div>
        {canAdd && (
          <div className="flex flex-wrap items-center gap-2">
            <Button iconLeft="upload" onClick={onUpload} variant="outline">
              {m.action_upload()}
            </Button>
            {/* Not on this branch yet: the Make a quiz dialog (X0a, X0b). */}
            <span title={m.study_panel_soon()}>
              <Button disabled>{m.dashboard_make_quiz()}</Button>
            </span>
          </div>
        )}
      </header>
      {practises && !!practice?.suggestions.length && (
        <section className="flex flex-col">
          <h2 className="t-subtitle">{m.dashboard_practise_next()}</h2>
          <SuggestedList
            list={practice.suggestions}
            onStart={(s) =>
              navigate({
                search: {
                  group: s.group,
                  reviewMode: s.mode,
                  study: 'practice' as const,
                  topicId: s.topicId,
                },
                to: '.',
              })
            }
          />
        </section>
      )}
      {items.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="t-subtitle">{m.dashboard_recent_files()}</h2>
          <div className="-mx-1 grid grid-cols-2 gap-x-2 gap-y-3 md:grid-cols-4 md:gap-4">
            {items.map((item) => (
              <RecentCard
                item={item}
                key={`${item.kind}-${item.id}`}
                workspaceId={workspace.id}
              />
            ))}
          </div>
        </section>
      )}
      {!!data?.activity.length && (
        <section className="flex flex-col">
          <h2 className="t-subtitle mb-2">{m.dashboard_activity()}</h2>
          <ul>
            {data.activity.map((row) => (
              <ActivityRow
                key={`${row.fileId ?? row.materialId}-${row.at}`}
                row={row}
                workspaceId={workspace.id}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** A Recent files card: the bordered preview with the name under it. */
function RecentCard({
  item,
  workspaceId,
}: {
  item: RecentItem;
  workspaceId: string;
}) {
  return (
    <PreviewCard
      asChild
      bordered
      icon={recentIcon(item)}
      thumbnail={recentThumbnail(item)}
      title={item.title}
    >
      <Link
        params={{ workspaceId }}
        preload="intent"
        search={
          item.kind === 'material' ? { material: item.id } : { file: item.id }
        }
        to="/workspaces/$workspaceId"
      />
    </PreviewCard>
  );
}

/** "Cara uploaded Week 2 slides.pptx", the actor and the item in bold; the row
 * opens the item. */
function ActivityRow({
  row,
  workspaceId,
}: {
  row: WorkspaceActivity;
  workspaceId: string;
}) {
  const name = row.actorName || m.dashboard_someone();
  const text =
    row.kind === 'agent'
      ? bold(m.dashboard_activity_agent, { title: row.title })
      : bold(
          row.kind === 'uploaded'
            ? m.dashboard_activity_uploaded
            : m.dashboard_activity_added,
          { name, title: row.title }
        );
  return (
    <li className="-mx-1.5 border-divider border-t first:border-t-0">
      <Link
        className="flex min-h-12 items-center gap-3 px-1.5 py-1.5 hover:bg-surface-hover-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
        params={{ workspaceId }}
        preload="intent"
        search={
          row.materialId ? { material: row.materialId } : { file: row.fileId }
        }
        to="/workspaces/$workspaceId"
      >
        {row.kind === 'agent' ? (
          <span className="grid size-7.5 shrink-0 place-items-center rounded-full bg-tint-accent-1 text-tint-accent-1-fg">
            <Icon name="ai" size={14} />
          </span>
        ) : (
          <Avatar
            aria-hidden
            className="size-7.5 shrink-0 text-[11px]"
            name={name}
            src={row.actorAvatarUrl || undefined}
          />
        )}
        <span className="min-w-0 flex-1">
          {text}
          {row.hidden && <HiddenMark className="ml-1.5 align-[-2px]" />}
        </span>
        <span className="t-meta shrink-0 text-fg-muted">
          {shortTime(row.at)}
        </span>
      </Link>
    </li>
  );
}

/** A message with its placeholders set in bold. */
function bold<K extends string>(
  message: (values: Record<K, string>) => string,
  values: Record<K, string>
): ReactNode {
  const marks = Object.fromEntries(
    Object.keys(values).map((key) => [key, `\u0000${key}\u0000`])
  ) as Record<K, string>;
  return message(marks)
    .split('\u0000')
    .map((part, i) =>
      i % 2 ? (
        <b className="font-bold" key={part}>
          {values[part as K]}
        </b>
      ) : (
        <Fragment key={`text-${i}`}>{part}</Fragment>
      )
    );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The boards' short times: "5 min", "2 h", "yesterday", a weekday within the
 * week, then the date. */
export function shortTime(iso: string, now = Date.now()) {
  const at = new Date(iso);
  const ago = now - at.getTime();
  if (ago < HOUR)
    return m.dashboard_minutes({
      count: Math.max(1, Math.round(ago / MINUTE)),
    });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday)
    return m.dashboard_hours({ count: Math.round(ago / HOUR) });
  if (at.getTime() >= startOfToday.getTime() - DAY)
    return new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' }).format(
      -1,
      'day'
    );
  if (at.getTime() >= startOfToday.getTime() - 6 * DAY)
    return new Intl.DateTimeFormat(getLocale(), { weekday: 'short' }).format(
      at
    );
  return new Intl.DateTimeFormat(getLocale(), {
    day: 'numeric',
    month: 'short',
  }).format(at);
}
