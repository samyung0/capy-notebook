import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useChapters,
  useFiles,
  useMaterials,
  useWorkspaceAttempts,
  useWorkspaceStudy,
} from '@/api/hooks';
import type { Attempt, ItemAttempts, MaterialRef } from '@/api/types';
import { FilterPopover, toggleValue } from '@/components/app/ListToolbar';
import { TabContent } from '@/components/app/tabPanel';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { fileKindLabel } from '@/features/files/fileKindLabel';
import { materialKindLabel } from '@/features/materials/MaterialListCard';
import type { OpenItem } from '@/features/materials/openItem';
import {
  readingOrder,
  type WorkspaceContentItem,
} from '@/features/workspace/workspaceContent';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { FILE_KINDS } from '@/lib/listSearch';
import { attemptMinutes, resultLink, scoreText } from './attempts';
import { PlaceholderRailMap } from './railMap/RailMap';
import { StudyMark, type StudyState, useStudyActions } from './studyItems';

const MATERIAL_TYPES: MaterialRef['type'][] = [
  'note',
  'mindmap',
  'diagram',
  'quiz',
  'flashcards',
];

type Show = 'all' | 'unread' | 'read' | 'untracked';
const SHOWS: Show[] = ['all', 'unread', 'read', 'untracked'];
const showLabel: Record<Show, () => string> = {
  all: m.progress_show_all,
  read: m.progress_show_read,
  unread: m.progress_show_unread,
  untracked: m.progress_show_untracked,
};
const shows = (show: Show, state: StudyState | undefined) =>
  show === 'all' ||
  (show === 'read' && state === 'done') ||
  (show === 'untracked' && state === 'removed') ||
  (show === 'unread' && state !== 'done' && state !== 'removed');

const kindOf = (item: WorkspaceContentItem) =>
  item.type === 'file' ? item.data.kind : item.data.type;
const titleOf = (item: WorkspaceContentItem) =>
  item.type === 'file' ? item.data.name : item.data.title;
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'short',
  });

/** A workspace's Study progress in the centre pane (human/study-progress.md,
 * 2026-10-19): every file and material by chapter in reading order, whether
 * it is read or tracked, and each quiz's and set's attempts. */
export function StudyProgress({
  workspaceId,
  onOpenItem,
  onOpenTrackProgress,
}: {
  workspaceId: string;
  onOpenItem: (item: OpenItem) => void;
  /** Opens workspace settings at the Track progress switch. */
  onOpenTrackProgress: () => void;
}) {
  const { data: study } = useWorkspaceStudy(workspaceId);
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const { data: attempts } = useWorkspaceAttempts(workspaceId);
  const { menuItems } = useStudyActions(workspaceId);
  const [kinds, setKinds] = useState<string[]>([]);
  const [show, setShow] = useState<Show>('all');
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  if (!(study && chapters && files && materials && attempts))
    return (
      <TabContent centered>
        <SkeletonList count={8} rowHeight={52} />
      </TabContent>
    );

  // Progress off: an empty railway saying so, and the way to turn it on.
  if (!study.enabled)
    return (
      <TabContent fill>
        <h2 className="t-card-title">{m.workspace_study_progress()}</h2>
        {/* The railway runs to the pane's edges, as on Learning. */}
        <div className="page-bleed-wide mt-6">
          <PlaceholderRailMap
            board={{
              text: m.progress_off_text(),
              title: m.progress_off_title(),
            }}
          />
        </div>
        <div className="mt-8 flex justify-center">
          <UnderlineLink accent onClick={onOpenTrackProgress}>
            {m.progress_off_turn_on()}
          </UnderlineLink>
        </div>
      </TabContent>
    );

  const states = new Map(
    study.items.map((it) => [it.fileId ?? it.materialId, it.state])
  );
  const changedAt = new Map(
    study.items.map((it) => [it.fileId ?? it.materialId, it.updatedAt])
  );
  const byMaterial = new Map(attempts.items.map((it) => [it.materialId, it]));
  const ordered = readingOrder(chapters, files, materials);
  const tracked = ordered.filter((it) => states.get(it.id) !== 'removed');
  const done = tracked.filter((it) => states.get(it.id) === 'done');
  const next = tracked.find((it) => states.get(it.id) !== 'done');
  // Kinds the workspace holds, files first in the Files page's order.
  const present = new Set(ordered.map(kindOf));
  const kindOptions = [
    ...FILE_KINDS.filter((kind) => present.has(kind)).map((kind) => ({
      label: fileKindLabel(kind),
      value: kind,
    })),
    ...MATERIAL_TYPES.filter((kind) => present.has(kind)).map((kind) => ({
      label: materialKindLabel(kind),
      value: kind,
    })),
  ];
  const visible = (it: WorkspaceContentItem) =>
    (!kinds.length || kinds.includes(kindOf(it))) &&
    shows(show, states.get(it.id));
  const sections = [
    ...[...chapters]
      .sort((a, b) => a.order - b.order)
      .map((ch) => ({ id: ch.id, name: ch.name })),
    { id: null, name: m.study_others() },
  ]
    .map((ch) => {
      const all = ordered.filter((it) => (it.data.chapterId ?? null) === ch.id);
      const mine = all.filter((it) => states.get(it.id) !== 'removed');
      return {
        ...ch,
        done: mine.filter((it) => states.get(it.id) === 'done').length,
        items: all.filter(visible),
        total: mine.length,
      };
    })
    .filter((ch) => ch.items.length > 0);

  // A row opens its file, or a practised quiz's or set's latest result.
  const toggle = (id: string) =>
    setOpen((prev) => {
      const nextOpen = new Set(prev);
      if (!nextOpen.delete(id)) nextOpen.add(id);
      return nextOpen;
    });

  return (
    <TabContent centered>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="min-w-0">
          <h2 className="t-card-title">{m.workspace_study_progress()}</h2>
          <p className="t-meta mt-1 text-fg-muted">
            {m.progress_summary({
              done: done.length,
              total: tracked.length,
              untracked: ordered.length - tracked.length,
            })}
          </p>
        </div>
        {next && (
          <UnderlineLink
            accent
            onClick={() => onOpenItem({ id: next.id, kind: next.type })}
          >
            {m.learning_continue_item({ title: titleOf(next) })}
          </UnderlineLink>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <FilterPopover
          filters={[
            {
              key: 'kind',
              label: m.files_filter_kind(),
              onToggle: (value) => setKinds(toggleValue(kinds, value)),
              options: kindOptions,
              selected: kinds,
            },
          ]}
          onResetFilters={() => setKinds([])}
        />
        <Select onValueChange={(value) => setShow(value as Show)} value={show}>
          <SelectTrigger
            aria-label={m.progress_show()}
            className="w-auto"
            variant="ghost-hover"
          >
            <SelectValue>{showLabel[show]()}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SHOWS.map((value) => (
              <SelectItem key={value} value={value}>
                {showLabel[value]()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {sections.length === 0 ? (
        <p className="py-8 text-center text-fg-muted">
          {m.progress_nothing_shown()}
        </p>
      ) : (
        sections.map((ch) => (
          <section className="mt-6" key={ch.id ?? 'others'}>
            <div className="flex items-baseline justify-between gap-3 pb-1.5">
              <h3 className="font-bold">{ch.name}</h3>
              {ch.total > 0 && (
                <span className="t-meta text-fg-muted">
                  {m.learning_done_of({ done: ch.done, total: ch.total })}
                </span>
              )}
            </div>
            {ch.items.map((it) => (
              <ProgressRow
                attempts={byMaterial.get(it.id)}
                expanded={open.has(it.id)}
                item={it}
                key={it.id}
                menuItems={menuItems(
                  { id: it.id, kind: it.type },
                  states.get(it.id)
                )}
                onOpen={() => onOpenItem({ id: it.id, kind: it.type })}
                onToggle={() => toggle(it.id)}
                readAt={changedAt.get(it.id)}
                state={states.get(it.id)}
                workspaceId={workspaceId}
              />
            ))}
          </section>
        ))
      )}
    </TabContent>
  );
}

function ProgressRow({
  item,
  readAt,
  state,
  attempts,
  expanded,
  menuItems,
  onOpen,
  onToggle,
  workspaceId,
}: {
  item: WorkspaceContentItem;
  /** When the item's state last changed: when it was marked read. */
  readAt?: string;
  state: StudyState | undefined;
  attempts?: ItemAttempts;
  expanded: boolean;
  menuItems: ReturnType<ReturnType<typeof useStudyActions>['menuItems']>;
  onOpen: () => void;
  onToggle: () => void;
  workspaceId: string;
}) {
  const latest = attempts?.recent[0];
  const name = titleOf(item);
  return (
    <div className="border-divider border-t">
      <div className="group relative -mx-1.5 flex items-center gap-3 rounded-input px-1.5 py-2.5 hover:bg-surface-hover-bg">
        <FileIcon
          className="mt-1 size-4 shrink-0 self-start"
          name={
            item.type === 'file'
              ? fileIconName(item.data)
              : materialIconName(item.data.type)
          }
        />
        <div className="min-w-0 flex-1">
          {latest ? (
            <Link
              className={cn(
                'wrap-break-word line-clamp-1 text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset',
                state === 'removed' && 'text-fg-muted'
              )}
              {...resultLink(latest)}
            >
              {name}
            </Link>
          ) : (
            <button
              className={cn(
                'wrap-break-word line-clamp-1 text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset',
                state === 'removed' && 'text-fg-muted'
              )}
              onClick={onOpen}
              type="button"
            >
              {name}
            </button>
          )}
          <p className="t-meta text-fg-muted">
            {rowMeta(item, state, readAt, attempts)}
          </p>
        </div>
        {latest && (
          <span className="whitespace-nowrap text-fg-secondary text-sm">
            {scoreText(latest)}
          </span>
        )}
        {attempts && attempts.count > 0 && (
          <button
            aria-expanded={expanded}
            aria-label={m.progress_toggle_results({ name })}
            className="relative z-10 grid size-7 shrink-0 place-items-center rounded-button text-fg-muted hover:bg-surface-dark"
            onClick={onToggle}
            type="button"
          >
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={16} />
          </button>
        )}
        <StudyMark state={state} />
        <div className="relative z-10 -my-2 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          <Menu items={menuItems} />
        </div>
      </div>
      {expanded && attempts && (
        <Results
          attempts={attempts}
          kind={item.type === 'material' ? item.data.type : 'quiz'}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}

/** "Read 9 Oct", or "3 attempts · 10 questions · last 16 Oct". */
function rowMeta(
  item: WorkspaceContentItem,
  state: StudyState | undefined,
  readAt: string | undefined,
  attempts?: ItemAttempts
) {
  if (state === 'removed') return m.progress_not_tracked();
  if (!attempts) {
    return state === 'done' && readAt
      ? m.progress_read_on({ date: shortDate(readAt) })
      : m.progress_not_read();
  }
  const quiz = item.type === 'material' && item.data.type === 'quiz';
  const size = quiz
    ? attempts.size === 1
      ? m.question_ui_one_question()
      : m.question_ui_question_count({ count: attempts.size })
    : attempts.size === 1
      ? m.progress_one_card()
      : m.material_ref_cards({ count: attempts.size });
  const latest = attempts.recent[0];
  if (!latest)
    return [
      quiz ? m.progress_not_attempted() : m.progress_not_studied(),
      size,
    ].join(' · ');
  return [
    attempts.count === 1
      ? m.progress_one_attempt()
      : m.progress_attempts({ count: attempts.count }),
    size,
    m.progress_last({ date: shortDate(latest.takenAt) }),
  ].join(' · ');
}

/** The last three results, each opening its result page, then All results
 * filtered by the workspace and the item's kind. */
function Results({
  attempts,
  kind,
  workspaceId,
}: {
  attempts: ItemAttempts;
  /** The quiz's or set's kind, for All results' filter. */
  kind: string;
  workspaceId: string;
}) {
  return (
    <ol className="mb-2 ml-1.5 border-divider border-l-2 pl-3.5">
      {attempts.recent.map((a: Attempt, i) => (
        <li
          className="relative -mx-1.5 flex items-center gap-3.5 rounded-input px-1.5 py-1.5 hover:bg-surface-hover-bg"
          key={a.id}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              {m.progress_attempt_n({ n: attempts.count - i })}
            </p>
            <p className="t-meta text-fg-muted">
              {[shortDate(a.takenAt), a.startedAt && attemptMinutes(a)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <span className="whitespace-nowrap text-fg-secondary text-sm">
            {scoreText(a)}
          </span>
          <UnderlineLink asChild noArrow>
            <Link className="after:absolute after:inset-0" {...resultLink(a)}>
              {m.quiz_check_result()}
            </Link>
          </UnderlineLink>
        </li>
      ))}
      {attempts.count > 0 && (
        <li className="py-1.5">
          <UnderlineLink asChild>
            <Link
              search={{ kind, tab: 'results', workspace: workspaceId }}
              to="/learning"
            >
              {m.progress_see_all_results()}
            </Link>
          </UnderlineLink>
        </li>
      )}
    </ol>
  );
}
