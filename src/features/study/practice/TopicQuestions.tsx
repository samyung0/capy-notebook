import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useMemo, useState } from 'react';
import { isApiError } from '@/api/client';
import {
  invalidateStudy,
  type QuestionsList,
  useMemberAnswer,
  useMemberProfile,
  useStudyQuestions,
  useStudyTopics,
} from '@/api/hooks';
import type { StudyQuestion, SummaryTopic } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import {
  ListToolbar,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { SkeletonList } from '@/components/ui/feedback';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { markGettingStarted } from '@/features/guide/gettingStarted';
import { answerLabels } from '@/features/questions/editorFields';
import { TextView } from '@/features/questions/TextView';
import type { LearnerQuestion, Question } from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { dayMonth } from '../assignments/assignmentText';
import { CheckedQuestion, QuestionItem } from '../ReviewQuestion';
import { studyLink } from '../studyRoutes';
import { LabelChip } from '../topicLabels';
import { BackLink, PracticeFrame } from './studyPage';

/* A topic's questions and Frequently wrong (Epo 2026-11-22, the topic
   questions mock): every question with its latest result, a row practising
   it in a dialog. A class's staff read a member's, a row opening the member's
   latest answer in the same dialog. */

type Result = StudyQuestion['result'];

const SQUARE: Record<Result, string> = {
  partial: 'bg-solid-warning',
  right: 'bg-solid-success',
  unattempted: 'bg-fg-muted/30',
  wrong: 'bg-solid-error',
};

/** Wrong first, then partly right, not tried and right. */
const RANK: Record<Result, number> = {
  partial: 1,
  right: 3,
  unattempted: 2,
  wrong: 0,
};

const keyOf = (q: StudyQuestion) => `${q.materialId}/${q.questionId}`;

/** The most missed first: by result, then misses, then the latest. */
function mostMissed(a: StudyQuestion, b: StudyQuestion) {
  return (
    RANK[a.result] - RANK[b.result] ||
    b.misses - a.misses ||
    (b.at ? Date.parse(b.at) : 0) - (a.at ? Date.parse(a.at) : 0)
  );
}

export const questionsListOf = (topic: string | undefined): QuestionsList =>
  topic === undefined
    ? { list: 'wrong' }
    : topic === 'others'
      ? { list: 'others' }
      : { list: 'topic', topicId: topic };

/** A question's row: a square for its latest check's result, as a topic
 * row's squares are its questions (Epo 2026-11-22, board H1), its prompt, its
 * quiz and when; the whole row opens it. */
export function QuestionRow({
  onOpen,
  q,
  showTopic,
}: {
  onOpen?: () => void;
  q: StudyQuestion;
  showTopic?: boolean;
}) {
  const body = (
    <>
      <span
        aria-hidden
        className={cn('mt-1 size-3 rounded-[3px]', SQUARE[q.result])}
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="line-clamp-2 font-semibold">
          <TextView marks text={q.text} />
        </span>
        <span className="t-meta flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-fg-muted">
          {showTopic && (
            <span className="t-meta inline-flex h-5.5 min-w-0 max-w-full items-center truncate whitespace-nowrap rounded-md bg-page-hover px-1.75 font-semibold text-fg-secondary">
              {q.group === 'others' ? m.topic_other_files() : q.topicName}
            </span>
          )}
          <span className="min-w-0 truncate">
            {q.at ? `${q.materialTitle} · ${dayMonth(q.at)}` : q.materialTitle}
          </span>
        </span>
      </span>
    </>
  );
  const row =
    'grid w-full grid-cols-[0.75rem_minmax(0,1fr)] items-start gap-x-3 border-divider border-b py-2.5 text-left';
  return (
    <li>
      {onOpen ? (
        <button
          className={cn(
            row,
            'outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset'
          )}
          onClick={onOpen}
          type="button"
        >
          {body}
        </button>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

/** One question at a time over the list: Check grades it as a review with no
 * session, so it counts as practice does; Next question goes on through the
 * list as shown. Closing refreshes the list and the labels. For a class's
 * staff (`memberId`) it shows the member's latest answer, marked, instead.
 * Either links to the question in its quiz. */
export function PractiseDialog({
  items,
  memberId,
  onClose,
  start,
  title,
  workspaceId,
}: {
  items: StudyQuestion[];
  memberId?: string;
  onClose: () => void;
  start: number;
  title: string;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [index, setIndex] = useState(start);
  const [checked, setChecked] = useState<{
    answers: Answers;
    question: Question;
  }>();
  const [answered, setAnswered] = useState(false);
  const q = items[index];
  if (!(q && (memberId || q.question))) return null;
  const last = index + 1 >= items.length;
  const next = () => {
    setChecked(undefined);
    setIndex(index + 1);
  };
  const close = () => {
    if (answered) void invalidateStudy(qc, workspaceId);
    onClose();
  };
  const quizLink = (
    <UnderlineLink
      className="justify-self-start"
      noArrow
      onClick={() => {
        close();
        void navigate({
          params: { workspaceId },
          search: { item: q.questionId, material: q.materialId },
          to: '/workspaces/$workspaceId',
        });
      }}
    >
      {m.topic_questions_open_quiz({ title: q.materialTitle })}
    </UnderlineLink>
  );
  const actions = (
    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
      {quizLink}
      <div className="flex shrink-0 gap-2">
        <Button onClick={close} variant="outline">
          {m.action_close()}
        </Button>
        {!last && (
          <Button iconRight="arrowRight" onClick={next}>
            {m.topic_questions_next()}
          </Button>
        )}
      </div>
    </div>
  );
  return (
    <SimpleDialog
      onClose={close}
      open
      title={
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="truncate">{title}</span>
          <span className="t-meta shrink-0 font-semibold text-fg-muted">
            {m.practice_position({ position: index + 1, total: items.length })}
          </span>
        </span>
      }
      width={720}
    >
      <div className="flex flex-col gap-3.5" key={keyOf(q)}>
        {memberId ? (
          <>
            <KeptAnswer
              memberId={memberId}
              number={index + 1}
              q={q}
              workspaceId={workspaceId}
            />
            {actions}
          </>
        ) : (
          <>
            <QuestionMeta number={index + 1} question={q.question} />
            {checked ? (
              <>
                <CheckedQuestion
                  answers={checked.answers}
                  question={checked.question}
                />
                {actions}
              </>
            ) : (
              <QuestionItem
                actions={
                  !last && (
                    <Button
                      className="h-9 px-3.5"
                      onClick={next}
                      rounded="normal"
                      size="sm"
                      variant="outline"
                    >
                      {m.topic_questions_skip()}
                    </Button>
                  )
                }
                item={{
                  itemId: q.questionId,
                  kind: 'question',
                  materialId: q.materialId,
                  materialTitle: q.materialTitle,
                  question: q.question,
                }}
                link={quizLink}
                onCheck={() => {
                  markGettingStarted('practice');
                  setAnswered(true);
                }}
                onChecked={(graded, answers) =>
                  setChecked({
                    answers,
                    question: graded.question as Question,
                  })
                }
              />
            )}
          </>
        )}
      </div>
    </SimpleDialog>
  );
}

/** "Question 2 · Ordering", and when it was answered on a member's. */
function QuestionMeta({
  at,
  number,
  question,
}: {
  at?: string;
  number: number;
  question?: Question | LearnerQuestion;
}) {
  const type = question?.parts[0]?.answer.type;
  const meta = m.practice_question_meta({
    number,
    type: type ? answerLabels[type]() : '',
  });
  return (
    <span className="t-meta font-semibold text-fg-muted">
      {at ? `${meta} · ${dayMonth(at)}` : meta}
    </span>
  );
}

/** A member's latest answer, marked, as a member's graded quiz result shows
 * it: plain lines, Your answer and Correct answer (Epo 2026-11-22, the
 * 2026-11-18 member result). */
function KeptAnswer({
  memberId,
  number,
  q,
  workspaceId,
}: {
  memberId: string;
  number: number;
  q: StudyQuestion;
  workspaceId: string;
}) {
  const { data, error, isError, isPending, refetch } = useMemberAnswer(
    workspaceId,
    memberId,
    q,
    { errorBoundary: false }
  );
  if (isPending) return <SkeletonList count={3} rowHeight={44} />;
  if (isError)
    return isApiError(error) && error.status === 404 ? (
      <ErrorState
        className="h-auto py-10"
        kind="notFound"
        title={m.topic_questions_answer_missing()}
        variant="panel"
      />
    ) : (
      <ErrorState
        className="h-auto py-10"
        errorId={unexpectedErrorId(error)}
        onRetry={() => void refetch()}
        title={m.topic_questions_answer_load_failed()}
        variant="panel"
      />
    );
  return (
    <>
      <QuestionMeta at={data.at} number={number} question={data.question} />
      <QuestionRunner
        answers={data.answers}
        disabled
        layout="list"
        partResults={false}
        question={data.question}
        review
      />
    </>
  );
}

type Sort = 'missed' | 'quiz';

/** A topic's questions (`topic`, an id or `others`) or Frequently wrong's
 * (none), the caller's own, or a member's for a class's staff (`memberId`,
 * read only, back to the profile). */
export function TopicQuestionsPage({
  memberId,
  show,
  topic,
  workspaceId,
}: {
  memberId?: string;
  show?: 'topics';
  topic?: string;
  workspaceId: string;
}) {
  const navigate = useNavigate();
  const list = questionsListOf(topic);
  const { data, error, isError, isPending, refetch } = useStudyQuestions(
    workspaceId,
    list,
    memberId,
    { errorBoundary: false }
  );
  // The topic's label and the member's name come with Summary or the profile.
  const { data: own } = useStudyTopics(workspaceId, {
    enabled: !memberId,
    errorBoundary: false,
  });
  const { data: profile } = useMemberProfile(workspaceId, memberId ?? '', {
    enabled: !!memberId,
    errorBoundary: false,
  });
  const topics = (memberId ? profile?.topics : own?.topics) ?? [];
  const standing = topics.find((t) =>
    list.list === 'topic' ? t.topicId === list.topicId : t.group === 'others'
  );
  const [results, setResults] = useState<Result[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [sort, setSort] = useState<{ ascending: boolean; value: Sort }>({
    ascending: true,
    value: 'missed',
  });
  const [practising, setPractising] = useState<number>();

  const rows = data?.questions ?? [];
  const shown = useMemo(() => {
    const kept = rows.filter((q) =>
      list.list === 'wrong'
        ? !picked.length || picked.includes(q.topicId ?? 'others')
        : !results.length || results.includes(q.result)
    );
    // Frequently wrong comes most missed first; Quiz order is the server's.
    const sorted =
      list.list === 'wrong' || sort.value === 'quiz'
        ? kept
        : [...kept].sort(mostMissed);
    return sort.ascending ? sorted : [...sorted].reverse();
  }, [rows, list.list, picked, results, sort]);
  // A learner practises what can be; staff open what the member answered.
  const opens = (q: StudyQuestion) => (memberId ? !!q.at : !!q.question);
  const openable = shown.filter(opens);

  const title =
    list.list === 'wrong'
      ? m.member_frequently_wrong()
      : list.list === 'others'
        ? m.topic_other_files()
        : (standing?.name ?? '');
  const back = (
    <BackLink
      label={memberId ? (profile?.name ?? '') : m.workspace_tab_study()}
      onClick={() =>
        void navigate(
          memberId
            ? studyLink(workspaceId, show === 'topics' ? 'topics' : 'summary', {
                member: memberId,
              })
            : studyLink(workspaceId, 'summary')
        )
      }
    />
  );
  if (isPending)
    return (
      <PracticeFrame className="lg:pt-6">
        {back}
        <SkeletonList className="mt-6" count={6} rowHeight={44} />
      </PracticeFrame>
    );
  if (isError)
    return (
      <PracticeFrame className="lg:pt-6">
        {back}
        {isApiError(error) && error.status === 404 ? (
          <ErrorState
            className="h-auto py-20"
            kind="notFound"
            title={m.topic_questions_not_found()}
            variant="panel"
          />
        ) : (
          <ErrorState
            className="h-auto py-20"
            errorId={unexpectedErrorId(error)}
            onRetry={() => void refetch()}
            title={m.topic_questions_load_failed()}
            variant="panel"
          />
        )}
      </PracticeFrame>
    );

  const asked = rows.filter((q) => q.result !== 'unattempted');
  const right = asked.filter((q) => q.result === 'right').length;
  const notTried = rows.length - asked.length;
  const meta = [
    memberId ? profile?.name : undefined,
    rows.length === 1
      ? m.practice_questions_one()
      : m.practice_questions({ count: rows.length }),
    list.list !== 'wrong' && asked.length
      ? m.summary_right({ asked: asked.length, right })
      : undefined,
    list.list !== 'wrong' && notTried
      ? m.topic_questions_not_tried({ count: notTried })
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const sorts: SortOption<Sort>[] = [
    { icon: 'retry', label: m.topic_questions_sort_missed(), value: 'missed' },
    { icon: 'quiz', label: m.topic_questions_sort_quiz(), value: 'quiz' },
  ];
  const topicOptions = topicFilterOptions(rows, topics);

  return (
    <PracticeFrame className="lg:pt-6">
      <div>{back}</div>
      <div className="mt-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:gap-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="t-page-title min-w-0 truncate">{title}</h1>
            {standing && list.list !== 'wrong' && (
              <LabelChip label={standing.label} />
            )}
          </div>
          <span className="t-meta text-fg-muted">{meta}</span>
        </div>
      </div>
      <ListToolbar
        className="mt-2"
        filters={
          list.list === 'wrong'
            ? [
                {
                  key: 'topic',
                  label: m.practice_col_topics(),
                  onToggle: (value) => setPicked(toggleValue(picked, value)),
                  options: topicOptions,
                  selected: picked,
                },
              ]
            : [
                {
                  key: 'result',
                  label: m.topic_questions_filter_result(),
                  onToggle: (value) =>
                    setResults(toggleValue(results, value as Result)),
                  options: [
                    { label: m.practice_outcome_wrong(), value: 'wrong' },
                    { label: m.practice_outcome_partly(), value: 'partial' },
                    {
                      label: m.topic_questions_not_tried_option(),
                      value: 'unattempted',
                    },
                    { label: m.practice_outcome_right(), value: 'right' },
                  ],
                  selected: results,
                },
              ]
        }
        inPage
        onResetFilters={() => {
          setPicked([]);
          setResults([]);
        }}
        sortMenu={
          list.list === 'wrong'
            ? undefined
            : {
                ascending: sort.ascending,
                onSortChange: (value, ascending) =>
                  setSort({ ascending, value }),
                sort: sort.value,
                sorts,
              }
        }
      />
      {rows.length === 0 ? (
        <Empty>{m.common_nothing_yet()}</Empty>
      ) : shown.length === 0 ? (
        <Empty>{m.common_no_matches()}</Empty>
      ) : (
        <ul className="mt-4">
          {shown.map((q) => (
            <QuestionRow
              key={keyOf(q)}
              onOpen={
                opens(q) ? () => setPractising(openable.indexOf(q)) : undefined
              }
              q={q}
              showTopic={list.list === 'wrong'}
            />
          ))}
        </ul>
      )}
      {practising !== undefined && (
        <PractiseDialog
          items={openable}
          memberId={memberId}
          onClose={() => setPractising(undefined)}
          start={practising}
          title={title}
          workspaceId={workspaceId}
        />
      )}
    </PracticeFrame>
  );
}

/** Frequently wrong's Topic filter: the topics its rows lead with, in topic
 * order, Other files last. */
function topicFilterOptions(rows: StudyQuestion[], topics: SummaryTopic[]) {
  const held = new Set(rows.map((q) => q.topicId ?? 'others'));
  return topics
    .filter((t) => held.has(t.topicId ?? 'others'))
    .map((t) => ({
      label: t.group === 'others' ? m.topic_other_files() : (t.name ?? ''),
      value: t.topicId ?? 'others',
    }));
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="t-meta mt-6 text-fg-muted">{children}</p>
);

/** Study's Overview for whoever practises: the three most missed questions,
 * each practised from here, and See all for the rest. Not drawn while there
 * are none, or while they load. */
export function FrequentlyWrongSection({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const navigate = useNavigate();
  const { data } = useStudyQuestions(
    workspaceId,
    { list: 'wrong' },
    undefined,
    {
      errorBoundary: false,
    }
  );
  const [practising, setPractising] = useState<number>();
  const rows = data?.questions ?? [];
  if (!rows.length) return null;
  const practisable = rows.filter((q) => q.question);
  return (
    <section>
      <div className="flex items-center gap-3">
        <h2 className="t-subtitle">{m.member_frequently_wrong()}</h2>
        <UnderlineLink
          className="ml-auto"
          noArrow
          onClick={() =>
            void navigate(studyLink(workspaceId, 'summary', { wrong: true }))
          }
        >
          {m.action_see_all()}
        </UnderlineLink>
      </div>
      <ul className="mt-1">
        {rows.slice(0, 3).map((q) => (
          <QuestionRow
            key={keyOf(q)}
            onOpen={
              q.question
                ? () => setPractising(practisable.indexOf(q))
                : undefined
            }
            q={q}
            showTopic
          />
        ))}
      </ul>
      {practising !== undefined && (
        <PractiseDialog
          items={practisable}
          onClose={() => setPractising(undefined)}
          start={practising}
          title={m.member_frequently_wrong()}
          workspaceId={workspaceId}
        />
      )}
    </section>
  );
}
