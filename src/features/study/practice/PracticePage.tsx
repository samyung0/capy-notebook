import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { usePractice, useTopics, useWorkspace } from '@/api/hooks';
import type {
  Practice,
  PracticeQuiz,
  PracticeReview,
  ReviewMode,
  SessionScore,
  Topic,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { materialIconName } from '@/lib/fileIcons';
import { questionsLabel, scoreText } from './practiceText';
import { SuggestedList } from './SuggestedList';
import { studyView } from './studyView';
import {
  PracticeFrame,
  PracticeResult,
  type PracticeStart,
  TopicPractice,
} from './TopicPractice';

/** The Practice page's URL, under `study=practice`: a topic session to
 * start (group, topic, a suggestion's mode) or a finished one's result. */
export type PracticeSearch = {
  group?: 'topic' | 'others' | 'workspace';
  topicId?: string;
  reviewMode?: ReviewMode;
  review?: string;
};

/** Study → Practice (Epo 2026-11-03, boards P1 and P2; who sees what, board
 * U3), the workspace's centre page while `study=practice` is in its URL. Whoever
 * practises gets Suggested and every quiz with their best score and Practise;
 * a class's owner and teaching assistants the same list with how members use
 * it. A topic session (F1, F1b) and its result (F4) keep the page's place: the
 * Study panel shows Practice. */
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
  const [topic, setTopic] = useState<string | null | undefined>(undefined);
  const { canEdit, manages: staff } = studyView(ws);
  const suggested = !staff && !!data?.suggestions.length;
  const topicName = (id?: string | null) =>
    id ? topics?.find((t) => t.id === id)?.name : undefined;
  const members = data?.members;
  const meta = [
    ws?.name,
    staff && members !== undefined
      ? members === 1
        ? m.workspace_members_one()
        : m.workspace_members_count({ count: members })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

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
        <div className="flex min-w-0 flex-wrap items-center gap-x-3">
          <h1 className="t-page-title">{m.study_panel_practice()}</h1>
          <span className="t-meta mt-1.5 text-fg-muted">{meta}</span>
        </div>
        {/* Not built yet (Make my own practice, P3; Add practice, P1). */}
        <span
          className={cn(suggested && '-my-2.5')}
          title={m.study_panel_soon()}
        >
          <Button disabled iconLeft="plus">
            {canEdit ? m.practice_add() : m.practice_make_own()}
          </Button>
        </span>
      </div>
      {isPending ? (
        <SkeletonList className="mt-6" count={6} rowHeight={40} />
      ) : isError ? (
        <ErrorState
          action={
            <Button onClick={() => void refetch()} variant="outline">
              {m.action_retry()}
            </Button>
          }
          className="mt-10"
          errorId={unexpectedErrorId(error)}
          title={m.practice_load_failed()}
          variant="panel"
        />
      ) : (
        <>
          {suggested && (
            <section className="mt-5.5">
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
          <AllPractice
            canEdit={canEdit}
            data={data}
            filter={topic}
            onFilter={setTopic}
            onStart={onStart}
            staff={staff}
            title={!staff}
            topicName={topicName}
            topics={topics ?? []}
          />
        </>
      )}
    </PracticeFrame>
  );
}

type Row =
  | {
      kind: 'review';
      key: string;
      topicId: string | null;
      review: PracticeReview;
    }
  | { kind: 'quiz'; key: string; topicId: string | null; quiz: PracticeQuiz };

/** Every quiz members can see, with the member's own topic reviews first
 * ("Only you"); a Topic filter keeps the rows on that topic. */
function AllPractice({
  canEdit,
  data,
  filter,
  onFilter,
  onStart,
  staff,
  title,
  topicName,
  topics,
}: {
  /** The owner and editors open a quiz from its row, to edit it. */
  canEdit: boolean;
  data: Practice;
  /** undefined is every topic; null is Other files. */
  filter: string | null | undefined;
  onFilter: (topic: string | null | undefined) => void;
  onStart: (start: PracticeStart) => void;
  staff: boolean;
  /** Members see the section's title (P2); owners the filter alone (P1). */
  title: boolean;
  topicName: (id?: string | null) => string | undefined;
  topics: Topic[];
}) {
  const navigate = useNavigate();
  const rows: Row[] = [
    ...(staff
      ? []
      : data.reviews.map(
          (review): Row => ({
            key: `review:${review.group}:${review.topicId ?? ''}`,
            kind: 'review',
            review,
            topicId: review.topicId ?? null,
          })
        )),
    ...data.quizzes.map(
      (quiz): Row => ({
        key: `quiz:${quiz.id}`,
        kind: 'quiz',
        quiz,
        topicId: quiz.topicId ?? null,
      })
    ),
  ];
  // The filter offers the topics the rows hold, in topic order, Other files last.
  const held = new Set(rows.map((r) => r.topicId));
  const options: { id: string | null; name: string }[] = [
    ...topics
      .filter((t) => held.has(t.id))
      .map((t) => ({ id: t.id, name: t.name })),
    ...(held.has(null) ? [{ id: null, name: m.topic_other_files() }] : []),
  ];
  const shown =
    filter === undefined ? rows : rows.filter((r) => r.topicId === filter);
  const filterName =
    filter === undefined
      ? m.practice_topic_all()
      : (options.find((o) => o.id === filter)?.name ?? m.practice_topic_all());
  const topicCell = (id: string | null) =>
    topicName(id) ?? m.topic_other_files();
  const practiseQuiz = (id: string) =>
    navigate({ params: { quizId: id }, to: '/quizzes/$quizId/attempt' });
  const openQuiz = (id: string) =>
    navigate({ search: { material: id }, to: '.' });
  const practiseReview = (r: PracticeReview) =>
    onStart({ group: r.group, topicId: r.topicId });
  const reviewTitle = (r: PracticeReview) =>
    m.practice_review_name({
      topic:
        r.group === 'others'
          ? m.topic_other_files()
          : topicCell(r.topicId ?? null),
    });

  return (
    <section className="@container mt-4">
      {/* 16px to the first text under it: phones' first row holds 11px above
          its text, the table's header 8px. */}
      <div className="@[740px]:mb-2 mb-1.25 flex items-center gap-2">
        {title && <h2 className="t-subtitle mr-2">{m.practice_all()}</h2>}
        {options.length > 0 && (
          <Menu
            align="start"
            items={[
              {
                checked: filter === undefined,
                label: m.practice_topic_all(),
                onClick: () => onFilter(undefined),
              },
              ...options.map((o) => ({
                checked: filter === o.id,
                label: o.name,
                onClick: () => onFilter(o.id),
              })),
            ]}
            trigger={
              <Button
                className="px-2.5"
                iconRight="chevronDown"
                size="sm"
                variant="outline"
              >
                {m.practice_topic_filter({ topic: filterName })}
              </Button>
            }
          />
        )}
      </div>
      {rows.length === 0 ? (
        <p className="t-meta mt-6 text-fg-muted">{m.practice_empty()}</p>
      ) : shown.length === 0 ? (
        <p className="t-meta mt-6 text-fg-muted">{m.practice_empty_topic()}</p>
      ) : (
        <>
          {/* Wide: the boards' table, once its fixed columns leave the Quiz
              column room. By the pane, which a dragged panel can narrow. */}
          <table className="@[740px]:table hidden w-full table-fixed border-separate border-spacing-0">
            <thead>
              <tr>
                <Th>{m.practice_col_quiz()}</Th>
                <Th className="w-60">{m.practice_col_topics()}</Th>
                <Th className="w-27.5">{m.practice_col_questions()}</Th>
                {staff ? (
                  <>
                    <Th className="w-32.5">{m.practice_col_tried()}</Th>
                    <Th className="w-35">{m.practice_col_average()}</Th>
                  </>
                ) : (
                  <>
                    <Th className="w-30">{m.practice_col_best()}</Th>
                    <Th className="w-27.5" />
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) =>
                row.kind === 'review' ? (
                  <tr key={row.key}>
                    <Td>
                      <ReviewName title={reviewTitle(row.review)} />
                    </Td>
                    <Td muted>{topicCell(row.topicId)}</Td>
                    <Td muted>{row.review.questions}</Td>
                    <Td>
                      <Best score={row.review.best} />
                    </Td>
                    <Td className="text-right">
                      <PractiseButton
                        onClick={() => practiseReview(row.review)}
                      />
                    </Td>
                  </tr>
                ) : (
                  <tr
                    className={cn(
                      canEdit &&
                        'cursor-pointer [&>td]:hover:bg-surface-hover-bg'
                    )}
                    key={row.key}
                    onClick={canEdit ? () => openQuiz(row.quiz.id) : undefined}
                  >
                    <Td>
                      <QuizName title={row.quiz.title} />
                    </Td>
                    <Td muted>{topicCell(row.topicId)}</Td>
                    <Td muted>{row.quiz.questions}</Td>
                    {staff ? (
                      <>
                        <Td muted>
                          {m.practice_tried_of({
                            members: data.members ?? 0,
                            tried: row.quiz.triedBy ?? 0,
                          })}
                        </Td>
                        <Td>
                          {row.quiz.average === undefined ? (
                            <span className="text-fg-muted">–</span>
                          ) : (
                            <span className="font-bold">
                              {`${Math.round(row.quiz.average * 100)}%`}
                            </span>
                          )}
                        </Td>
                      </>
                    ) : (
                      <>
                        <Td>
                          <Best score={row.quiz.best} />
                        </Td>
                        <Td className="text-right">
                          <PractiseButton
                            onClick={() => practiseQuiz(row.quiz.id)}
                          />
                        </Td>
                      </>
                    )}
                  </tr>
                )
              )}
            </tbody>
          </table>
          {/* Phones and narrow panes: one row per item, its facts under it. */}
          <ul className="@[740px]:hidden">
            {shown.map((row) => {
              const review = row.kind === 'review' ? row.review : null;
              const quiz = row.kind === 'quiz' ? row.quiz : null;
              const facts = [
                topicCell(row.topicId),
                questionsLabel(review?.questions ?? quiz?.questions ?? 0),
                staff && quiz
                  ? m.practice_tried_of({
                      members: data.members ?? 0,
                      tried: quiz.triedBy ?? 0,
                    })
                  : null,
              ].filter(Boolean);
              const score = review?.best ?? quiz?.best;
              return (
                <li
                  className="flex min-h-14 items-center gap-3 border-divider border-b py-2"
                  key={row.key}
                >
                  <div className="min-w-0 flex-1">
                    {review ? (
                      <ReviewName compact title={reviewTitle(review)} />
                    ) : (
                      <QuizName title={quiz?.title ?? ''} />
                    )}
                    <div className="t-meta mt-0.5 flex min-w-0 items-center gap-1 pl-6 text-fg-muted">
                      {review && <OnlyYou />}
                      <span className="truncate">
                        {`${review ? '· ' : ''}${facts.join(' · ')}`}
                      </span>
                    </div>
                  </div>
                  {staff ? (
                    quiz?.average !== undefined && (
                      <span className="font-bold">{`${Math.round((quiz?.average ?? 0) * 100)}%`}</span>
                    )
                  ) : (
                    <>
                      {score && (
                        <span className="font-bold">{scoreText(score)}</span>
                      )}
                      <PractiseButton
                        onClick={() =>
                          review
                            ? practiseReview(review)
                            : practiseQuiz(quiz?.id ?? '')
                        }
                      />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function Th({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <th
      className={cn(
        't-meta border-divider border-b px-3 py-1.5 text-left align-bottom font-semibold text-fg-muted',
        className
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
  muted,
}: {
  children?: ReactNode;
  className?: string;
  muted?: boolean;
}) {
  return (
    <td
      className={cn(
        'h-10 truncate border-divider border-b px-3',
        muted && 'font-semibold text-fg-muted',
        className
      )}
    >
      {children}
    </td>
  );
}

function QuizName({ title }: { title: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <FileIcon className="size-4 shrink-0" name={materialIconName('quiz')} />
      <span className="truncate font-semibold">{title}</span>
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

function PractiseButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      size="sm"
      variant="outline"
    >
      {m.practice_practise()}
    </Button>
  );
}
