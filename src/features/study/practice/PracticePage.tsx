import { useNavigate } from '@tanstack/react-router';
import { type KeyboardEvent, useState } from 'react';
import {
  usePractice,
  useStudyTopics,
  useTopics,
  useWorkspace,
} from '@/api/hooks';
import type {
  Practice,
  PracticeItem,
  PracticeReview,
  ReviewMode,
  SessionScore,
  Topic,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { ListToolbar, toggleValue } from '@/components/app/ListToolbar';
import type { ColumnSort } from '@/components/app/SortHeader';
import { PageButton } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { isWorkspaceReadOnly } from '@/features/workspace/access';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { materialIconName } from '@/lib/fileIcons';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import { MakePractice } from './MakePractice';
import { scoreText, sizeLabel } from './practiceText';
import { SuggestedList } from './SuggestedList';
import {
  ListRow,
  PracticeFrame,
  RowScore,
  StudyTabs,
  Td,
  Th,
  TopicsCell,
} from './studyPage';
import { studyView } from './studyView';
import {
  PracticeResult,
  type PracticeStart,
  TopicPractice,
} from './TopicPractice';
import { TopicsSection, weakestTopicId } from './TopicsSection';

/** The Practice page's URL, under `study=practice`: a topic session to
 * start (group, topic, a suggestion's mode) or a finished one's result. */
export type PracticeSearch = {
  group?: 'topic' | 'others' | 'workspace';
  topicId?: string;
  reviewMode?: ReviewMode;
  review?: string;
};

/** Practice (Epo 2026-11-03, boards P1 and P2; who sees what, board U3; its own
 * page on the rail since Epo 2026-11-11), the workspace's centre page while
 * `study=practice` is in its URL. Whoever practises gets Suggested, Topics and
 * every quiz and set with their best score, the row starting it; a class's owner and teaching
 * assistants the same list with how members use it. A topic session (F1, F1b)
 * and its result (F4) keep the page's place: the rail shows Practice. */
export function PracticePage({
  search,
  workspaceId,
}: {
  search: PracticeSearch;
  workspaceId: string;
}) {
  const navigate = useNavigate();
  const go = (next: PracticeSearch, replace = false) =>
    navigate({
      replace,
      search: { study: 'practice' as const, ...next },
      to: '.',
    });
  const start: PracticeStart | null = search.group
    ? {
        group: search.group,
        reviewMode: search.reviewMode,
        topicId: search.topicId,
      }
    : null;
  if (search.review)
    return (
      <PracticeResult
        key={search.review}
        onAgain={(again) => go(again)}
        onBack={() => go({})}
        sessionId={search.review}
      />
    );
  const list = (
    <PracticeList onStart={(s) => go(s)} workspaceId={workspaceId} />
  );
  if (!start) return list;
  return (
    <TopicPractice
      behind={list}
      key={[start.group, start.topicId, start.reviewMode].join('|')}
      onClose={() => go({}, true)}
      onDone={(review) => go({ review }, true)}
      start={start}
      workspaceId={workspaceId}
    />
  );
}

function PracticeList({
  onStart,
  workspaceId,
}: {
  onStart: (start: PracticeStart) => void;
  workspaceId: string;
}) {
  const { data: ws } = useWorkspace(workspaceId);
  const { data: topics } = useTopics(workspaceId);
  const { data, error, isError, isPending, refetch } = usePractice(
    workspaceId,
    { errorBoundary: false }
  );
  const { canEdit, manages: staff } = studyView(ws);
  // Whoever practises gets Topics on the same page: drawn together, so
  // nothing below it moves (the staff are refused topics).
  const { data: studyTopics, isPending: topicsPending } = useStudyTopics(
    workspaceId,
    { enabled: !!ws && !staff, errorBoundary: false }
  );
  const loading = isPending || !ws || (!staff && topicsPending);
  const revealRef = useLoadingReveal(loading);
  const [making, setMaking] = useState(false);
  const navigate = useNavigate();
  const suggested = !staff && !!data?.suggestions.length;
  const topicName = (id?: string | null) =>
    id ? topics?.find((t) => t.id === id)?.name : undefined;

  return (
    <PracticeFrame>
      {/* Spread apart on one line; wrapped, the action starts its own line
          at the left, 16px from the text above and whatever follows. Suggested
          has more over it (its top margin), which the action's negative margins
          take back; on one line the title's height decides, so they cancel
          out. */}
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-x-3',
          suggested ? 'gap-y-4.75' : 'gap-y-2.25'
        )}
      >
        {/* The title alone: no hint text beside it (Epo 2026-11-13). */}
        <h1 className="t-page-title">{m.workspace_tab_study()}</h1>
        {/* Whoever may edit adds a quiz for everyone (Add practice's dialog,
            Make a quiz's address); anyone else makes their own. */}
        <span className={cn(suggested && '-my-2.5')}>
          <PageButton
            disabled={canEdit && isWorkspaceReadOnly(ws?.capabilities)}
            iconLeft="plus"
            onClick={() =>
              canEdit
                ? void navigate({
                    search: { make: 'files', makeFrom: 'practice' },
                    to: '.',
                  })
                : setMaking(true)
            }
          >
            {canEdit ? m.practice_add() : m.practice_make_own()}
          </PageButton>
        </span>
      </div>
      <StudyTabs staff={staff} value={staff ? 'practice' : 'summary'} />
      {loading ? (
        <SkeletonList className="mt-6" count={6} rowHeight={40} />
      ) : isError ? (
        <ErrorState
          className="h-auto py-20"
          errorId={unexpectedErrorId(error)}
          onRetry={() => void refetch()}
          title={m.practice_load_failed()}
          variant="panel"
        />
      ) : (
        // Sections 26px apart, the Dashboard's gap (Epo 2026-11-13). Staff
        // start with the toolbar, whose Filter sits 8px into its row: 16px
        // under the tabs, as on Files.
        <div
          className={cn('flex flex-col gap-6.5', staff ? 'mt-2' : 'mt-5.5')}
          ref={revealRef}
        >
          {suggested && (
            <section>
              <h2 className="t-subtitle">{m.practice_suggested()}</h2>
              <SuggestedList
                list={data.suggestions}
                onStart={(s) =>
                  onStart({
                    group: s.group,
                    reviewMode: s.mode,
                    topicId: s.topicId,
                  })
                }
              />
            </section>
          )}
          {/* Whoever practises: their own standing per topic. */}
          {!staff && <TopicsSection workspaceId={workspaceId} />}
          <AllPractice
            canEdit={canEdit}
            data={data}
            onStart={onStart}
            staff={staff}
            title={!staff}
            topicName={topicName}
            topics={topics ?? []}
          />
        </div>
      )}
      {making && (
        <MakePractice
          // On the weakest topic, from the Overview's own topics.
          initialTopicId={weakestTopicId(studyTopics?.topics ?? [])}
          onClose={() => setMaking(false)}
          onlyYou={!canEdit}
          workspaceId={workspaceId}
        />
      )}
    </PracticeFrame>
  );
}

/** All practice's column sorts; `order` is reading order, no column active. */
type PracticeSort =
  | 'order'
  | 'name'
  | 'topic'
  | 'size'
  | 'best'
  | 'tried'
  | 'average';

/** `topicIds`: a review's topic, or what a quiz or set covers (its topic, then
 * its questions' own, Epo 2026-11-15). */
type Row =
  | {
      kind: 'review';
      key: string;
      topicIds: string[];
      review: PracticeReview;
    }
  | { kind: 'item'; key: string; topicIds: string[]; item: PracticeItem };

/** Every quiz and set members can see, with the member's own topic reviews first
 * ("Only you"), in reading order until a column sorts them. The shared Filter
 * keeps the rows on the topics picked (Epo 2026-11-13). */
function AllPractice({
  canEdit,
  data,
  onStart,
  staff,
  title,
  topicName,
  topics,
}: {
  /** A class's staff open a quiz or set from its row, to edit it. */
  canEdit: boolean;
  data: Practice;
  onStart: (start: PracticeStart) => void;
  staff: boolean;
  /** Members see the section's title (P2); owners the filter alone (P1). */
  title: boolean;
  topicName: (id?: string | null) => string | undefined;
  topics: Topic[];
}) {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<string[]>([]);
  const [order, setOrder] = useState<{
    ascending: boolean;
    sort: PracticeSort;
  }>({ ascending: true, sort: 'order' });
  const sorting: ColumnSort<PracticeSort> = {
    ascending: order.ascending,
    ascendingFirst: ['name', 'topic'],
    onSortChange: (sort, ascending) => setOrder({ ascending, sort }),
    sort: order.sort,
  };
  const rows: Row[] = [
    ...(staff
      ? []
      : data.reviews.map(
          (review): Row => ({
            key: `review:${review.group}:${review.topicId ?? ''}`,
            kind: 'review',
            review,
            topicIds: review.topicId ? [review.topicId] : [],
          })
        )),
    ...data.items.map(
      (item): Row => ({
        item,
        key: `${item.kind}:${item.id}`,
        kind: 'item',
        topicIds: item.covers,
      })
    ),
  ];
  // The filter offers the topics the rows hold, in topic order: no Other
  // files, which is no topic (Epo 2026-11-13). A row holds every topic it covers.
  const held = new Set(rows.flatMap((r) => r.topicIds));
  const options = topics
    .filter((t) => held.has(t.id))
    .map((t) => ({ label: t.name, value: t.id }));
  const filtered =
    picked.length === 0
      ? rows
      : rows.filter((r) => r.topicIds.some((id) => picked.includes(id)));
  const reviewTitle = (r: PracticeReview) =>
    m.practice_review_name({
      topic:
        (r.group === 'others' ? undefined : topicName(r.topicId)) ??
        m.topic_other_files(),
    });
  // The whole row is the action (Epo 2026-11-13): whoever practises starts
  // it; a class's staff open the quiz or set, to edit it.
  const open = (row: Row) => {
    if (row.kind === 'review')
      return onStart({ group: row.review.group, topicId: row.review.topicId });
    if (staff)
      return canEdit
        ? navigate({ search: { material: row.item.id }, to: '.' })
        : undefined;
    return row.item.kind === 'quiz'
      ? navigate({
          params: { quizId: row.item.id },
          to: '/quizzes/$quizId/attempt',
        })
      : navigate({
          params: { flashcardSetId: row.item.id },
          to: '/flashcards/$flashcardSetId',
        });
  };
  const nameOf = (row: Row) =>
    row.kind === 'review' ? reviewTitle(row.review) : row.item.title;
  // A column's value per row; what a row lacks sorts last either way.
  const columnValue = (row: Row): string | number | undefined => {
    const item = row.kind === 'item' ? row.item : null;
    const best = row.kind === 'review' ? row.review.best : item?.best;
    switch (order.sort) {
      case 'name':
        return nameOf(row);
      case 'topic':
        return topicName(row.topicIds[0]);
      case 'size':
        return row.kind === 'review' ? row.review.questions : item?.size;
      case 'best':
        return best && best.total > 0 ? best.correct / best.total : undefined;
      case 'tried':
        return item?.triedBy;
      case 'average':
        return item?.average;
      default:
        return;
    }
  };
  const shown =
    order.sort === 'order'
      ? filtered
      : [...filtered].sort((x, y) => {
          const a = columnValue(x);
          const b = columnValue(y);
          if (a === undefined || b === undefined)
            return a === b ? 0 : a === undefined ? 1 : -1;
          const by =
            typeof a === 'string' && typeof b === 'string'
              ? a.localeCompare(b, undefined, { numeric: true })
              : Number(a) - Number(b);
          return order.ascending ? by : -by;
        });
  const opens = !staff || canEdit;
  const rowProps = (row: Row) =>
    opens
      ? {
          onClick: () => void open(row),
          onKeyDown: (event: KeyboardEvent) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            void open(row);
          },
          role: 'link',
          tabIndex: 0,
        }
      : {};

  return (
    <section className="@container">
      {options.length > 0 ? (
        // The list pages' toolbar (Epo 2026-11-16): -mb-1 is its -mb-3 with
        // the 8px a PageBody under it adds.
        <ListToolbar
          before={title && <h2 className="t-subtitle">{m.practice_all()}</h2>}
          className="-mb-1"
          filters={[
            {
              key: 'topic',
              label: m.practice_col_topics(),
              onToggle: (value) => setPicked(toggleValue(picked, value)),
              options,
              selected: picked,
            },
          ]}
          inPage
          onResetFilters={() => setPicked([])}
        />
      ) : (
        title && <h2 className="t-subtitle mb-2">{m.practice_all()}</h2>
      )}
      {rows.length === 0 ? (
        <p className="t-meta mt-6 text-fg-muted">{m.practice_empty()}</p>
      ) : shown.length === 0 ? (
        <p className="t-meta mt-6 text-fg-muted">{m.practice_empty_topic()}</p>
      ) : (
        <>
          {/* Wide: the boards' table, once its fixed columns leave the Name
              column room. By the pane, which a dragged panel can narrow. */}
          <table className="@[740px]:table hidden w-full table-fixed border-separate border-spacing-0">
            <thead>
              <tr>
                <Th sort={{ sorting, value: 'name' as const }}>
                  {m.list_col_name()}
                </Th>
                <Th
                  className="w-60"
                  sort={{ sorting, value: 'topic' as const }}
                >
                  {m.practice_col_topics()}
                </Th>
                <Th
                  className="w-27.5"
                  sort={{ sorting, value: 'size' as const }}
                >
                  {m.practice_col_size()}
                </Th>
                {staff ? (
                  <>
                    <Th
                      className="w-32.5"
                      sort={{ sorting, value: 'tried' as const }}
                    >
                      {m.practice_col_tried()}
                    </Th>
                    <Th
                      className="w-35"
                      sort={{ sorting, value: 'average' as const }}
                    >
                      {m.practice_col_average()}
                    </Th>
                  </>
                ) : (
                  <Th
                    className="w-30"
                    sort={{ sorting, value: 'best' as const }}
                  >
                    {m.practice_col_best()}
                  </Th>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr
                  className={cn(
                    opens &&
                      'cursor-pointer outline-none hover:[&>td]:bg-surface-hover-bg focus-visible:[&>td]:bg-surface-hover-bg'
                  )}
                  key={row.key}
                  {...rowProps(row)}
                >
                  <Td>
                    {row.kind === 'review' ? (
                      <ReviewName title={reviewTitle(row.review)} />
                    ) : (
                      <ItemName
                        kind={row.item.kind}
                        onlyYou={row.item.onlyYou}
                        title={row.item.title}
                      />
                    )}
                  </Td>
                  <Td muted>
                    <TopicsCell topicIds={row.topicIds} topicName={topicName} />
                  </Td>
                  <Td muted>
                    {row.kind === 'review'
                      ? row.review.questions
                      : row.item.size}
                  </Td>
                  {row.kind === 'review' ? (
                    <Td>
                      <Best score={row.review.best} />
                    </Td>
                  ) : staff ? (
                    <>
                      <Td muted>
                        {m.practice_tried_of({
                          members: data.members ?? 0,
                          tried: row.item.triedBy ?? 0,
                        })}
                      </Td>
                      <Td>
                        {row.item.average === undefined ? (
                          <span className="text-fg-muted">–</span>
                        ) : (
                          <span className="font-bold">
                            {`${Math.round(row.item.average * 100)}%`}
                          </span>
                        )}
                      </Td>
                    </>
                  ) : (
                    <Td>
                      <Best score={row.item.best} />
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {/* Phones and narrow panes: one row per item, its facts under it. */}
          <ul className="@[740px]:hidden">
            {shown.map((row) => {
              const review = row.kind === 'review' ? row.review : null;
              const item = row.kind === 'item' ? row.item : null;
              const [topic, ...more] = row.topicIds;
              // Nothing while the topics load, fail or lack this one.
              const name = topic ? topicName(topic) : undefined;
              const facts = [
                name && `${name}${more.length > 0 ? ` +${more.length}` : ''}`,
                review
                  ? sizeLabel('quiz', review.questions)
                  : item && sizeLabel(item.kind, item.size),
                staff && item
                  ? m.practice_tried_of({
                      members: data.members ?? 0,
                      tried: item.triedBy ?? 0,
                    })
                  : null,
              ].filter(Boolean);
              const score = review?.best ?? item?.best;
              return (
                <ListRow
                  className={cn(
                    opens &&
                      'cursor-pointer outline-none hover:bg-surface-hover-bg focus-visible:bg-surface-hover-bg'
                  )}
                  key={row.key}
                  {...rowProps(row)}
                >
                  <div className="min-w-0 flex-1">
                    {review ? (
                      <ReviewName compact title={reviewTitle(review)} />
                    ) : (
                      <ItemName
                        kind={item?.kind ?? 'quiz'}
                        onlyYou={item?.onlyYou}
                        title={item?.title ?? ''}
                      />
                    )}
                    <div className="t-meta mt-0.5 flex min-w-0 items-center gap-1 pl-6 text-fg-muted">
                      {review && <OnlyYou />}
                      <span className="truncate">
                        {`${review ? '· ' : ''}${facts.join(' · ')}`}
                      </span>
                    </div>
                  </div>
                  {staff
                    ? item?.average !== undefined && (
                        <RowScore
                          label={m.study_score_average()}
                          value={`${Math.round(item.average * 100)}%`}
                        />
                      )
                    : score && (
                        <RowScore
                          label={m.study_score_best()}
                          value={scoreText(score)}
                        />
                      )}
                </ListRow>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function ItemName({
  kind,
  onlyYou,
  title,
}: {
  kind: PracticeItem['kind'];
  onlyYou?: boolean;
  title: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <FileIcon className="size-4 shrink-0" name={materialIconName(kind)} />
      <span className="truncate font-semibold">{title}</span>
      {onlyYou && <OnlyYou />}
    </div>
  );
}

/** A member's own topic review: private, so it says "Only you" (on
 * phones in the facts line under it). */
function ReviewName({ compact, title }: { compact?: boolean; title: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="shrink-0 text-fg-muted" name="rotateCw" size={16} />
      <span className="truncate font-semibold">{title}</span>
      {!compact && <OnlyYou />}
    </div>
  );
}

function OnlyYou() {
  return (
    <span className="t-meta inline-flex shrink-0 items-center gap-1 text-fg-muted">
      <Icon name="lock" size={16} />
      {m.practice_only_you()}
    </span>
  );
}

function Best({ score }: { score?: SessionScore }) {
  return score ? (
    <span className="font-bold">{scoreText(score)}</span>
  ) : (
    <span className="text-fg-muted">–</span>
  );
}
