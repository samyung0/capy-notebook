import { zodResolver } from '@hookform/resolvers/zod';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Link,
  linkOptions,
  useMatchRoute,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, isApiError } from '@/api/client';
import {
  bankQuestionsQueryQMax,
  commentBankQuestionBodyTextMax,
} from '@/api/gen/validators';
import type { BankTopicProgress } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import {
  FilterPopover,
  type FilterSection,
  toggleValue,
} from '@/components/app/ListToolbar';
import {
  PageBody,
  PageHeader,
  Panel,
  PanelHeader,
} from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { PhoneTopRow } from '@/components/app/Sidebar';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Skeleton, SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { InputError } from '@/components/ui/Input';
import { SearchInput } from '@/components/ui/SearchInput';
import { Textarea } from '@/components/ui/TextArea';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { userToast } from '@/components/ui/userToast';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import {
  BANK_STATUSES,
  type BankDetail,
  type BankExam,
  type BankListFilters,
  type BankMode,
  type BankRow,
  type BankSyllabus,
  type BankTopic,
  bankBatchQuery,
  bankListQuery,
  bankMarksQuery,
  bankProgressQuery,
  bankQuestionQuery,
  bankSummaryQuery,
  bankSyllabusQuery,
  bankTopicKey,
  checkBankQuestion,
  soleSubject,
  soleTopic,
  statusLabels,
  storeBankEdit,
  topicPath,
  uploadBankAsset,
} from '@/features/questions/bank';
import { searchSyllabus } from '@/features/questions/bankSearch';
import { ExamSection, topicCount } from '@/features/questions/ExamPicker';
import { answerLabels } from '@/features/questions/editorFields';
import { TopicSummary } from '@/features/questions/TopicSummary';
import { finishKey } from '@/features/questions/trailMap/finish';
import {
  PlaceholderTrailMap,
  TrailMap,
} from '@/features/questions/trailMap/TrailMap';
import {
  type LearnerQuestion,
  QUESTION_TYPES,
  type Question,
} from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { type Crumb, QuizPageHeader } from '@/features/quizzes/QuizPageHeader';
import {
  OUTCOME_FILL,
  outcomeOf,
  squareLabel,
} from '@/features/quizzes/ResultSummary';
import { PanelSearch } from '@/features/workspace/PanelSearch';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { CopyError, describeError, unexpectedErrorId } from '@/lib/errors';
import { waitsForConnection } from '@/lib/online';
import { holdPosition, scrollSettled } from '@/lib/scrollAnchor';
import { scrollIntoViewWithMotion } from '@/lib/scrollIntoViewWithMotion';
import { useDebounced } from '@/lib/useDebounced';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { useNear } from '@/lib/useNear';

const QuestionDialog = lazy(() =>
  import('@/features/questions/QuestionDialog').then((module) => ({
    default: module.QuestionDialog,
  }))
);
const commentSchema = z.object({
  text: z.string().trim().min(1).max(commentBankQuestionBodyTextMax),
});
/** Search buttons centred where the search field's ✕ sits, with room around
 * the icon, the usual light hover and no tooltip (the icon is the label). */
const SEARCH_BUTTON = 'mr-0.5 size-8 rounded-md';
/** Questions per load; the window grows by this many as the reader nears its end. */
const PAGE = 10;

/**
 * Question bank: every question of the chosen topic in the main panel; one
 * tree of exams, subjects, topics and the open topic's question squares in
 * the right column from xl, and in a dialog behind a chooser button below it.
 */
export default function QuestionBank() {
  const { topicId = '', questionId = '' } = useParams({ strict: false }) as {
    topicId?: string;
    questionId?: string;
  };
  const navigate = useNavigate();
  const client = useQueryClient();
  const search = useSearch({ strict: false });
  const matchRoute = useMatchRoute();
  // A finished topic's Summary opens /qb/$topicId/summary in the same page.
  const summary = Boolean(matchRoute({ to: '/qb/$topicId/summary' }));
  // Below xl the tree opens in a dialog from the chooser button.
  const [chooserOpen, setChooserOpen] = useState(false);
  const xl = useMediaQuery('(min-width: 1280px)');
  useEffect(() => {
    if (xl) setChooserOpen(false);
  }, [xl]);
  const [topicFilter, setTopicFilter] = useState('');
  const [filter, setFilter] = useState('');
  const [unreviewed, setUnreviewed] = useState(false);
  const [types, setTypes] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  // The list opens on the page holding this question: the URL's question when
  // the topic or a filter changes, or one the loaded pages do not hold.
  const [anchor, setAnchor] = useState(questionId);
  const [searching, setSearching] = useState(false);
  const [shownTopic, setShownTopic] = useState(topicId);
  if (shownTopic !== topicId) {
    setShownTopic(topicId);
    setFilter('');
    setSearching(false);
    setTypes([]);
    setStatuses([]);
    setAnchor(questionId);
  }
  const [editing, setEditing] = useState<BankDetail | null>(null);
  const [conflict, setConflict] = useState(false);
  const [commentFor, setCommentFor] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data: syllabus, fetchStatus } = useQuery(bankSyllabusQuery());
  const mode = syllabus?.editor && search.mode === 'edit' ? 'edit' : 'view';
  // Learners' results lead the list rows in view mode only.
  const { data: results, error: resultsError } = useQuery({
    ...bankMarksQuery(topicId),
    enabled: Boolean(topicId) && mode === 'view',
    meta: { errorBoundary: false },
  });
  const marks = mode === 'view' && !resultsError ? results?.marks : undefined;
  const { data: topicSummary } = useQuery({
    ...bankSummaryQuery(topicId),
    enabled: summary,
  });
  // The summary's finished date and next topic, and the tree's last
  // attempted topic, come from the landing's list.
  const { data: progress } = useQuery(bankProgressQuery());
  const searchText = useDebounced(filter);
  // The server filters with the learner's results at request time; loaded
  // pages keep a question answered while filtered until a filter changes.
  const listFilters: BankListFilters = {
    search: searchText,
    statuses: marks ? statuses : [],
    types,
    unreviewed: mode === 'edit' && unreviewed,
  };
  const {
    data: list,
    error: listError,
    isPending: listPending,
    isFetching: listFetching,
    isPlaceholderData: listStale,
    hasNextPage,
    hasPreviousPage,
    isFetchingNextPage,
    fetchNextPage,
    fetchPreviousPage,
  } = useInfiniteQuery({
    ...bankListQuery(topicId, listFilters, anchor),
    // The side list stays while a new filter loads.
    placeholderData: keepPreviousData,
  });
  const rows = list?.pages.flatMap((page) => page.items) ?? [];
  const listed = rows.some((row) => row.id === questionId);
  useEffect(() => {
    if (questionId && !listFetching && !listed) setAnchor(questionId);
  }, [questionId, listFetching, listed]);
  /** A filter change reopens the list around the current question. */
  function refilter<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      setAnchor(questionId);
    };
  }
  const filters: FilterSection[] = [
    {
      key: 'type',
      label: m.question_ui_question_type(),
      onToggle: (value) => refilter(setTypes)(toggleValue(types, value)),
      options: QUESTION_TYPES.filter((type) =>
        list?.pages[0]?.answerTypes.includes(type)
      ).map((type) => ({ label: answerLabels[type](), value: type })),
      selected: types,
    },
  ];
  if (marks)
    filters.push({
      key: 'status',
      label: m.common_status(),
      onToggle: (value) => refilter(setStatuses)(toggleValue(statuses, value)),
      options: BANK_STATUSES.map((status) => ({
        label: statusLabels[status](),
        value: status,
      })),
      selected: statuses,
    });
  const { mutateAsync: saveQuestion } = useMutation({
    mutationFn: ({
      snapshot,
      question,
    }: {
      snapshot: BankDetail;
      question: Question;
    }) =>
      api.put<BankDetail>(
        '/bank/questions/' + encodeURIComponent(question.id),
        { question, updatedAt: snapshot.updatedAt }
      ),
    onSuccess: (saved) => {
      storeBankEdit(client, saved);
      void client.invalidateQueries({
        queryKey: bankTopicKey(saved.topicId),
      });
    },
  });
  const { mutate: setReviewed, isPending: reviewing } = useMutation({
    mutationFn: ({ id, reviewed }: { id: string; reviewed: boolean }) =>
      api.put<BankDetail>(
        '/bank/questions/' + encodeURIComponent(id) + '/review',
        { reviewed }
      ),
    onSuccess: (saved) => {
      storeBankEdit(client, saved);
      void client.invalidateQueries({
        queryKey: bankTopicKey(saved.topicId),
      });
      void client.invalidateQueries({ queryKey: bankSyllabusQuery().queryKey });
    },
  });

  const modeSearch = {
    mode: search.mode === 'edit' ? ('edit' as const) : undefined,
  };
  function setMode(next: 'view' | 'edit') {
    const options = {
      replace: true,
      search: {
        exam: search.exam,
        mode: next === 'edit' ? ('edit' as const) : undefined,
      },
    };
    if (topicId)
      void navigate({ ...options, params: { topicId }, to: '/qb/$topicId' });
    else void navigate({ ...options, to: '/qb' });
  }
  function topic(id: string) {
    setChooserOpen(false);
    void navigate({
      params: { topicId: id },
      search: modeSearch,
      to: '/qb/$topicId',
    });
  }
  /** From the landing: Continue opens the next question, Summary the topic's summary. */
  function openProgress(id: string, next: string | null) {
    if (next)
      void navigate({
        params: { questionId: next, topicId: id },
        search: modeSearch,
        to: '/qb/$topicId/$questionId',
      });
    else {
      scrollRef.current?.scrollTo({ top: 0 });
      void navigate({
        params: { topicId: id },
        search: modeSearch,
        to: '/qb/$topicId/summary',
      });
    }
  }
  function select(id: string) {
    setChooserOpen(false);
    // The URL does not change for the current question, so scroll directly.
    if (id === questionId) scrollToQuestion(id);
    void navigate({
      params: { questionId: id, topicId },
      replace: true,
      search: modeSearch,
      to: '/qb/$topicId/$questionId',
    });
  }

  const place = syllabus?.exams
    .flatMap((exam) =>
      exam.subjects.flatMap((subject) =>
        subject.topics.map((item) => ({ exam, item, subject }))
      )
    )
    .find(({ item }) => item.id === topicId);

  // The names shown above the open topic; the last one titles the page
  // (the summary is titled Summary, under the topic).
  const path = place && topicPath(place.exam, place.subject, place.item);
  // The trail above the title ends on the page's parent: the bank, then the
  // exam and subject, which both open the exam in the panel, and on the
  // summary the topic itself; Back goes to the last one.
  const bankLink = linkOptions({ search: modeSearch, to: '/qb' });
  const trail: Crumb[] =
    place && path
      ? [
          { label: m.question_ui_question_bank(), link: bankLink },
          ...path.slice(0, -1).map((label) => ({
            label,
            link: linkOptions({
              search: { ...modeSearch, exam: place.exam.id },
              to: '/qb',
            }),
          })),
          ...(summary
            ? [
                {
                  // What the topic page is titled (an exam's sole topic
                  // takes the exam's name).
                  label: path.at(-1) ?? place.item.label,
                  link: linkOptions({
                    params: { topicId },
                    search: modeSearch,
                    to: '/qb/$topicId',
                  }),
                },
              ]
            : []),
        ]
      : [];

  // The summary's next topic: the first unfinished one after this topic in its
  // subject, wrapping to the start.
  const progressById = new Map(
    progress?.topics.map((item) => [item.topicId, item])
  );
  const finished = progressById.get(topicId);
  const nextTopic = (() => {
    if (!(summary && place && progress)) return null;
    const topics = place.subject.topics;
    const at = topics.findIndex((item) => item.id === topicId);
    const found = [...topics.slice(at + 1), ...topics.slice(0, at)].find(
      (item) =>
        item.total > 0 && progressById.get(item.id)?.nextQuestionId !== null
    );
    return found
      ? {
          id: found.id,
          label: found.label,
          started: progressById.has(found.id),
          subjectLabel: place.subject.label,
          total: found.total,
        }
      : null;
  })();

  // Exams and subjects the tree opens: the open topic's, `?exam=`, and the
  // last attempted topic's.
  const last = progress?.topics[0];
  const opened = [
    place?.exam.id,
    place?.subject.id,
    search.exam,
    last?.examId,
    last?.subjectId,
  ].filter((id): id is string => Boolean(id));
  const tree = (dialog?: boolean) =>
    syllabus ? (
      <TopicTree
        dialog={dialog}
        edit={mode === 'edit'}
        filter={topicFilter}
        onFilter={setTopicFilter}
        onQuestion={select}
        onTopic={topic}
        opened={opened}
        progress={progressById}
        questionId={questionId}
        syllabus={syllabus}
        topicId={topicId}
      />
    ) : (
      <SkeletonList count={8} rowHeight={28} />
    );
  // Below xl: named after the open topic's exam, else Choose exam. Long
  // names truncate at 160px on phones, 240px from sm.
  const chooserLabel = place?.exam.label ?? m.question_ui_choose_exam();
  const chooser = syllabus && (
    <button
      aria-haspopup="dialog"
      className="flex h-10 min-w-0 max-w-40 items-center gap-1.5 rounded-button border border-line px-3.5 font-semibold text-base leading-normal tracking-normal hover:bg-surface-hover-bg sm:max-w-60"
      onClick={() => setChooserOpen(true)}
      type="button"
    >
      <span className="min-w-0 truncate">{chooserLabel}</span>
      <Icon className="size-3.5 shrink-0 text-fg-muted" name="chevronDown" />
    </button>
  );
  // Below xl it sits at the right of the page's title row, or of the
  // landing's Continue title.
  const tabletChooser = chooser && (
    <span className="flex xl:hidden">{chooser}</span>
  );
  // The landing shows Continue in View mode once a topic is started.
  const continuing = mode === 'view' && Boolean(progress?.topics.length);
  // Under a topic's title: edit mode's All/Unreviewed on the left, Filter and
  // question search on the right.
  const tools = place && !summary && (
    <div className="page-px flex min-h-9 flex-wrap items-center gap-x-1 pt-3">
      {searching ? (
        <div className="ml-auto w-full max-w-sm">
          <SearchInput
            actionCallback={() => {
              refilter(setFilter)('');
              setSearching(false);
            }}
            actionIcon="x"
            actionLabel={m.question_ui_close_search()}
            aria-label={m.question_ui_find_a_question()}
            autoFocus
            maxLength={bankQuestionsQueryQMax}
            onChange={(event) => refilter(setFilter)(event.target.value)}
            placeholder={m.question_ui_find_a_question()}
            value={filter}
          />
        </div>
      ) : (
        <>
          {mode === 'edit' && (
            <>
              <Button
                aria-pressed={!unreviewed}
                className="-ml-2"
                onClick={() => refilter(setUnreviewed)(false)}
                rounded="large"
                size="sm"
                variant={unreviewed ? 'ghost-hover' : 'gray'}
              >
                {m.action_all()} {place.item.total}
              </Button>
              <Button
                aria-pressed={unreviewed}
                onClick={() => refilter(setUnreviewed)(true)}
                rounded="large"
                size="sm"
                variant={unreviewed ? 'gray' : 'ghost-hover'}
              >
                {m.question_ui_unreviewed()}{' '}
                {place.item.total - place.item.reviewed}
              </Button>
            </>
          )}
          <div className="ml-auto flex items-center gap-x-1">
            <FilterPopover
              filters={filters}
              onResetFilters={() => {
                setTypes([]);
                setStatuses([]);
                setAnchor(questionId);
              }}
            />
            <ToolbarButton
              // The icon, not the button, on the page's right edge.
              className={cn(SEARCH_BUTTON, '-mr-2')}
              label={m.question_ui_find_a_question()}
              onClick={() => setSearching(true)}
              tooltip={false}
            >
              <Icon name="search" />
            </ToolbarButton>
          </div>
        </>
      )}
    </div>
  );

  let body: ReactNode;
  if (waitsForConnection(fetchStatus, syllabus)) body = <QueryPausedState />;
  else if (!syllabus)
    body = (
      <div aria-label={m.a11y_loading()} role="status">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  else if (!topicId)
    body = (
      <BankLanding
        aside={tabletChooser}
        exams={syllabus.exams}
        finishedTopic={search.finished}
        onOpen={openProgress}
        onStart={topic}
        view={mode === 'view'}
      />
    );
  else if (summary) {
    if (topicSummary)
      body = (
        <TopicSummary
          next={nextTopic}
          onNext={(next) =>
            next.started
              ? openProgress(
                  next.id,
                  progressById.get(next.id)?.nextQuestionId ?? null
                )
              : topic(next.id)
          }
          onOpen={(id) =>
            void navigate({
              params: { questionId: id, topicId },
              search: modeSearch,
              to: '/qb/$topicId/$questionId',
            })
          }
          questions={topicSummary.questions}
        />
      );
    else body = <Skeleton className="h-64 w-full" />;
  } else if (listPending || listStale)
    body = <Skeleton className="h-64 w-full" />;
  else if (rows.length)
    body = (
      <BankQuestions
        // A new topic, filter or anchor starts a new window.
        hasEarlier={hasPreviousPage}
        hasMore={hasNextPage}
        key={JSON.stringify([topicId, listFilters, anchor])}
        loadEarlier={() => fetchPreviousPage(joinFetch)}
        loadingMore={isFetchingNextPage}
        loadMore={() => fetchNextPage(joinFetch)}
        mode={mode}
        moreError={isFetchingNextPage ? null : listError}
        onComment={setCommentFor}
        onEdit={(detail) => setEditing(structuredClone(detail))}
        onReview={(detail) =>
          setReviewed({
            id: detail.question.id,
            reviewed: !detail.reviewedAt,
          })
        }
        questionId={questionId}
        reviewing={reviewing}
        rows={rows}
        scrollRef={scrollRef}
        topicId={topicId}
      />
    );
  else
    body = (
      <p className="text-fg-muted">{m.question_ui_no_questions_match()}</p>
    );

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 sm:gap-2.5 xl:flex-row">
      {/* The topics panel from xl; below it the page is one column. */}
      <div className="order-last hidden h-full shrink-0 flex-col gap-2.5 xl:flex xl:w-(--top-inset-bar-width)">
        <Panel
          className="min-h-0 flex-1"
          frost="right"
          sectionClassName="scroll-fade-y h-full px-2 py-5 [--scroll-fade-bottom-padding:--spacing(5)]"
        >
          {tree()}
        </Panel>
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <Panel
          className="min-h-0 flex-1 rounded-button sm:rounded-card-xl"
          frost="center"
          scrollRef={scrollRef}
          sectionClassName="h-full gap-0 pb-10"
        >
          <PhoneTopRow className="shrink-0 px-4 pt-3 pb-2" />
          {topicId ? (
            <>
              <QuizPageHeader
                actions={
                  // Phones stack the exam picker over Edit, leaving the title
                  // its width.
                  <div className="flex flex-col-reverse items-end gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                    {summary ? (
                      <UnderlineLink accent onClick={() => topic(topicId)}>
                        {m.question_ui_go_through_again()}
                      </UnderlineLink>
                    ) : (
                      syllabus?.editor && (
                        <Button
                          iconLeft={mode === 'edit' ? 'view' : 'pencil'}
                          onClick={() =>
                            setMode(mode === 'edit' ? 'view' : 'edit')
                          }
                          rounded="large"
                          size="sm"
                        >
                          {mode === 'edit'
                            ? m.question_ui_view_mode()
                            : m.question_ui_edit()}
                        </Button>
                      )
                    )}
                    {tabletChooser}
                  </div>
                }
                // The bank's normal gutter, as on its main page.
                gutter="normal"
                meta={
                  place &&
                  [
                    summary &&
                      finished &&
                      !finished.nextQuestionId &&
                      m.question_ui_finished_on({
                        date: new Date(
                          finished.lastAnsweredAt
                        ).toLocaleDateString(getLocale(), {
                          day: 'numeric',
                          month: 'short',
                        }),
                      }),
                    place.item.total === 1
                      ? m.question_ui_one_question()
                      : m.question_ui_question_count({
                          count: place.item.total,
                        }),
                    mode === 'edit' &&
                      m.question_ui_reviewed_count({
                        count: place.item.reviewed,
                      }),
                  ]
                    .filter(Boolean)
                    .join(' · ')
                }
                onBack={() => void navigate(trail.at(-1)?.link ?? bankLink)}
                title={
                  summary
                    ? m.question_ui_summary()
                    : (path?.at(-1) ?? m.question_ui_question_bank())
                }
                trail={trail}
                // Phones find their way with the chooser and the browser's back.
                trailClassName="max-sm:hidden"
              />
              {tools}
              <PageBody className="pt-6 pb-10 sm:pt-6">{body}</PageBody>
            </>
          ) : (
            <>
              <PageHeader
                actions={
                  <>
                    {syllabus?.editor && (
                      <Button
                        iconLeft={mode === 'edit' ? 'view' : 'pencil'}
                        onClick={() =>
                          setMode(mode === 'edit' ? 'view' : 'edit')
                        }
                        rounded="large"
                        size="sm"
                      >
                        {mode === 'edit'
                          ? m.question_ui_view_mode()
                          : m.question_ui_edit()}
                      </Button>
                    )}
                    {!continuing && tabletChooser}
                  </>
                }
                className="justify-between md:flex-1"
                subtitle={m.question_ui_bank_hint()}
                title={m.question_ui_question_bank()}
              />
              <PageBody className="pb-10 sm:pt-8">{body}</PageBody>
            </>
          )}
        </Panel>
      </div>
      <SimpleDialog
        onClose={() => setChooserOpen(false)}
        open={chooserOpen}
        title={m.question_ui_exams_and_topics()}
      >
        {tree(true)}
      </SimpleDialog>
      {editing && (
        <Suspense fallback={null}>
          <QuestionDialog
            bankAssetsUrl={syllabus?.assetsUrl}
            context={editing.topicLabel}
            onClose={() => {
              setEditing(null);
              setConflict(false);
            }}
            onReload={
              conflict
                ? async () => {
                    const latest = await client.fetchQuery({
                      ...bankQuestionQuery(editing.question.id, 'edit'),
                      staleTime: 0,
                    });
                    setEditing(structuredClone(latest));
                    setConflict(false);
                    return latest.question as Question;
                  }
                : undefined
            }
            onSave={async (question) => {
              try {
                await saveQuestion({ question, snapshot: editing });
                setEditing(null);
                setConflict(false);
              } catch (error) {
                if (isApiError(error) && error.status === 409) {
                  setConflict(true);
                  void client.invalidateQueries({
                    queryKey: bankQuestionQuery(question.id, 'edit').queryKey,
                  });
                  throw new CopyError(m.question_ui_conflict_message(), {
                    cause: error,
                  });
                }
                throw error;
              }
            }}
            open
            policy="bank"
            question={editing.question as Question}
            questionNumber={editing.position}
            uploadAsset={uploadBankAsset}
          />
        </Suspense>
      )}
      {commentFor && (
        <BankComment id={commentFor} onClose={() => setCommentFor('')} />
      )}
    </div>
  );
}

const questionElement = (id: string) =>
  document.querySelector(`[data-question-id="${CSS.escape(id)}"]`);

/** Scrolls only the panel (scrollIntoView would also move the app shell when
 * the panel cannot scroll far enough), with the editor TOC's motion. */
function scrollToQuestion(id: string) {
  const element = questionElement(id);
  if (element instanceof HTMLElement) scrollIntoViewWithMotion(element, 24);
}

/**
 * The loaded rows as a window of full questions that grows PAGE at a time as
 * the reader nears its end, loading the list's next page when the window
 * reaches it. Jumping to a question outside the window (or not next to it)
 * restarts the window at the question. Earlier questions (the list's previous
 * page first, if needed) load the same way near the window's start, going in
 * only once scrolling settles and with the reading position held
 * (src/lib/scrollAnchor.ts).
 */
function BankQuestions({
  rows,
  hasMore,
  hasEarlier,
  loadingMore,
  loadMore,
  moreError,
  loadEarlier,
  questionId,
  topicId,
  mode,
  reviewing,
  scrollRef,
  onReview,
  onComment,
  onEdit,
}: {
  rows: BankRow[];
  hasMore: boolean;
  hasEarlier: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<unknown>;
  /** The last page load failed; loading more waits for Retry. */
  moreError: Error | null;
  loadEarlier: () => Promise<{
    data?: { pages: { items: BankRow[] }[] };
    error: Error | null;
  }>;
  questionId: string;
  topicId: string;
  mode: BankMode;
  reviewing: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onReview: (detail: BankDetail) => void;
  onComment: (id: string) => void;
  onEdit: (detail: BankDetail) => void;
}) {
  const client = useQueryClient();
  const target = rows.findIndex((row) => row.id === questionId);
  // Indices into rows, counted from the row `base` so that loading earlier
  // pages, which puts rows in front, leaves the window where it is.
  const [view, setView] = useState(() => ({
    base: rows[0]?.id,
    ...(target >= 0 ? around(target) : { end: PAGE, start: 0 }),
  }));
  const shift = Math.max(
    0,
    rows.findIndex((row) => row.id === view.base)
  );
  const range = { end: view.end + shift, start: view.start + shift };
  const setRange = (next: { start: number; end: number }) =>
    setView({ base: rows[0]?.id, ...next });
  const shown = rows.slice(range.start, range.end);
  const { error, isFetching, refetch } = useQuery({
    ...bankBatchQuery(
      client,
      shown.map((row) => row.id),
      mode
    ),
    meta: { errorBoundary: false },
  });
  // Read-only views of the cache the batch fills.
  const details = useQueries({
    queries: shown.map((row) => ({
      ...bankQuestionQuery(row.id, mode),
      enabled: false,
    })),
  });

  useEffect(() => {
    if (target < 0) return;
    const next = jump(range, target);
    if (next !== range) setRange(next);
  });
  // Scroll once the question and everything above it in the window has loaded.
  const targetReady =
    target >= range.start &&
    target < range.end &&
    details.slice(0, target - range.start + 1).every((query) => query.data);
  useEffect(() => {
    if (targetReady) scrollToQuestion(questionId);
  }, [questionId, targetReady]);

  // Grow the window when its end comes within 800px of the viewport.
  const endRef = useRef<HTMLDivElement>(null);
  const nearEnd = useNear(endRef, '0px 0px 800px 0px', scrollRef);
  useEffect(() => {
    if (!nearEnd || isFetching || error || moreError) return;
    if (range.end < rows.length) setRange({ ...range, end: range.end + PAGE });
    else if (hasMore && !loadingMore) void loadMore();
  });

  // Earlier questions load as the window's start comes within 800px: fetched
  // first, then put in once scrolling settles, with the reading position held.
  const startRef = useRef<HTMLDivElement>(null);
  const nearStart = useNear(
    startRef,
    '800px 0px 0px 0px',
    scrollRef,
    range.start
  );
  const earlierLeft = range.start > 0 || hasEarlier;
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<Error | null>(null);
  const hold = useRef<(() => void) | null>(null);
  // The rows and window of the latest render, for showEarlier after its waits.
  const latest = useRef({ range, rows });
  latest.current = { range, rows };
  useEffect(() => {
    if (nearStart && earlierLeft && !loadingEarlier && !earlierError)
      void showEarlier();
  });
  async function showEarlier() {
    setLoadingEarlier(true);
    try {
      const first = rows[range.start];
      let list = rows;
      if (range.start === 0) {
        const result = await loadEarlier();
        if (result.error) throw result.error;
        list = result.data?.pages.flatMap((page) => page.items) ?? rows;
      }
      const start = list.findIndex((row) => row.id === first?.id);
      await client.fetchQuery(
        bankBatchQuery(
          client,
          list.slice(Math.max(0, start - PAGE), start).map((row) => row.id),
          mode
        )
      );
      await scrollSettled();
      // A jump while waiting moved the window on; it loads its own.
      const now = latest.current;
      const element = first && questionElement(first.id);
      if (!element || now.rows[now.range.start]?.id !== first.id) return;
      const at = now.rows.findIndex((row) => row.id === first.id);
      hold.current = holdPosition(element);
      setView({
        base: now.rows[0]?.id,
        end: at + now.range.end - now.range.start,
        start: Math.max(0, at - PAGE),
      });
    } catch (loadError) {
      setEarlierError(
        loadError instanceof Error ? loadError : new Error(String(loadError))
      );
    } finally {
      setLoadingEarlier(false);
    }
  }
  // The commit after holdPosition is the one that put the questions in.
  useLayoutEffect(() => {
    hold.current?.();
    hold.current = null;
  });

  return (
    <div className="relative grid gap-12">
      {/* Out of the grid flow, so it adds no gap above the first question. */}
      <div aria-hidden className="absolute top-0" ref={startRef} />
      {earlierError ? (
        <BankError error={earlierError} onRetry={() => setEarlierError(null)} />
      ) : (
        earlierLeft && <Skeleton className="h-40 w-full" />
      )}
      <ol className="grid gap-12">
        {shown.map((row, i) => {
          const detail = details[i]?.data;
          return (
            <li className="grid gap-4" data-question-id={row.id} key={row.id}>
              {detail ? (
                <>
                  {mode === 'view' ? (
                    <CheckableQuestion
                      question={detail.question}
                      questionNumber={row.position}
                      topicId={topicId}
                    />
                  ) : (
                    <QuestionRunner
                      answers={{}}
                      disabled
                      question={detail.question}
                      questionNumber={row.position}
                      showAnswerKey={detail.editor}
                    />
                  )}
                  {mode === 'edit' && detail.editor && (
                    <ReviewBar
                      detail={detail}
                      onComment={() => onComment(detail.question.id)}
                      onEdit={() => onEdit(detail)}
                      onReview={() => onReview(detail)}
                      reviewing={reviewing}
                    />
                  )}
                  <MaterialAttributionFooter provenance={detail.provenance} />
                </>
              ) : (
                <Skeleton className="h-40 w-full" />
              )}
            </li>
          );
        })}
      </ol>
      {error && (
        <BankError
          error={error}
          onRetry={() => {
            // A 404 means a question left the topic; the list drops it.
            void client.invalidateQueries({ queryKey: bankTopicKey(topicId) });
            void refetch();
          }}
        />
      )}
      {!error && moreError && (
        <BankError error={moreError} onRetry={() => void loadMore()} />
      )}
      <div aria-hidden className="-mt-12" ref={endRef} />
    </div>
  );
}

/**
 * View mode: the learner answers, and Check answer grades them on the server,
 * which records the result and returns this question's key for the quiz
 * review; Try again starts over.
 */
function CheckableQuestion({
  question,
  questionNumber,
  topicId,
}: {
  question: Question | LearnerQuestion;
  questionNumber: number;
  topicId: string;
}) {
  const client = useQueryClient();
  const [answers, setAnswers] = useState<Answers>({});
  const {
    data: checked,
    isPending,
    mutate: check,
    reset,
  } = useMutation({
    mutationFn: (sent: Answers) =>
      checkBankQuestion(question.id, { answers: sent }),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: bankMarksQuery(topicId).queryKey,
      });
      void client.invalidateQueries({ queryKey: bankProgressQuery().queryKey });
      void client.invalidateQueries({
        queryKey: bankSummaryQuery(topicId).queryKey,
      });
    },
  });
  return (
    <>
      <QuestionRunner
        answers={answers}
        disabled={Boolean(checked) || isPending}
        onChange={(partId, value) =>
          setAnswers((current) => ({ ...current, [partId]: value }))
        }
        question={checked?.question ?? question}
        questionNumber={questionNumber}
        review={Boolean(checked)}
      />
      <div className="flex justify-end">
        {checked ? (
          <Button
            className="h-9 px-3.5"
            iconLeft="refresh"
            onClick={() => {
              reset();
              setAnswers({});
            }}
            rounded="normal"
            size="sm"
            variant="ghost-hover"
          >
            {m.question_ui_answer_again()}
          </Button>
        ) : (
          // Sized like the review session's Check.
          <Button
            className="h-9 px-3.5"
            disabled={isPending}
            onClick={() => check(answers)}
            rounded="normal"
            size="sm"
          >
            {m.question_ui_check()}
          </Button>
        )}
      </div>
    </>
  );
}

// Both panels load pages; a second call joins the request in flight.
const joinFetch = { cancelRefetch: false };

/** A question's page and the next one, so the question can scroll to the top. */
function around(index: number) {
  const start = Math.floor(index / PAGE) * PAGE;
  return { end: start + 2 * PAGE, start };
}

/** Extend the window to a question on or next to it, else restart around it. */
function jump(range: { start: number; end: number }, index: number) {
  const next = around(index);
  if (next.start < range.start - PAGE || next.start > range.end) return next;
  const start = Math.min(range.start, next.start);
  const end = Math.max(range.end, next.end);
  return start === range.start && end === range.end ? range : { end, start };
}

/** Title with a search icon that expands into a full-width field. */
function PanelHeading({
  title,
  filter,
  onFilter,
  searchLabel,
}: {
  title: string;
  filter: string;
  onFilter: (value: string) => void;
  searchLabel: string;
}) {
  const [searching, setSearching] = useState(filter !== '');
  const searchButton = (
    <ToolbarButton
      className={SEARCH_BUTTON}
      label={searchLabel}
      onClick={() => setSearching(true)}
      tooltip={false}
    >
      <Icon name="search" />
    </ToolbarButton>
  );
  // Both states share one height, so opening the search moves nothing.
  return (
    <div className="grid h-9 items-center">
      {searching ? (
        <div>
          <SearchInput
            actionCallback={() => {
              onFilter('');
              setSearching(false);
            }}
            actionIcon="x"
            actionLabel={m.question_ui_close_search()}
            aria-label={searchLabel}
            autoFocus
            maxLength={bankQuestionsQueryQMax}
            onChange={(event) => onFilter(event.target.value)}
            placeholder={searchLabel}
            value={filter}
          />
        </div>
      ) : (
        <PanelHeader actions={searchButton} title={title} />
      )}
    </div>
  );
}

/** Bolds the first case-insensitive match of the search in a label. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  const at = needle ? text.toLocaleLowerCase().indexOf(needle) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <b className="font-extrabold">{text.slice(at, at + needle.length)}</b>
      {text.slice(at + needle.length)}
    </>
  );
}

/**
 * Every exam as a cover strip that opens in place (several may stay open),
 * then its subjects and topics; the open topic lists its questions as squares.
 * `opened` exams and subjects open on top of what the learner has opened, so
 * a new topic or `?exam=` reveals itself without closing anything. A search
 * lists exams, subjects and topics from every exam together (searchSyllabus).
 */
function TopicTree({
  syllabus,
  topicId,
  questionId,
  edit,
  filter,
  onFilter,
  onTopic,
  onQuestion,
  opened,
  progress,
  dialog,
}: {
  syllabus: BankSyllabus;
  topicId: string;
  questionId: string;
  edit: boolean;
  filter: string;
  onFilter: (value: string) => void;
  onTopic: (id: string) => void;
  onQuestion: (id: string) => void;
  opened: string[];
  /** Started topics by id, whose rows count answered of total. */
  progress: Map<string, BankTopicProgress>;
  /** In the chooser dialog, whose title heads it: the search field shows
   * at the top instead of the panel's heading. */
  dialog?: boolean;
}) {
  const [open, setOpen] = useState(() => new Set(opened));
  // Only ids new to `opened` reveal themselves: opening a topic in another
  // exam must not reopen the last attempted exam the learner closed.
  const [seen, setSeen] = useState(opened);
  if (seen.join() !== opened.join()) {
    const added = opened.filter((id) => !seen.includes(id));
    setSeen(opened);
    setOpen((prev) => new Set([...prev, ...added]));
  }
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const reveal = (...ids: string[]) =>
    setOpen((prev) => new Set([...prev, ...ids]));
  const needle = filter.trim().toLocaleLowerCase();
  const count = (item: BankTopic) => {
    const answered = progress.get(item.id)?.answered;
    return (
      <span className="shrink-0 font-semibold text-fg-muted text-xs">
        {edit
          ? `${item.reviewed}/${item.total}`
          : answered
            ? m.study_of({ done: answered, total: item.total })
            : item.total}
      </span>
    );
  };
  const found = needle ? searchSyllabus(syllabus.exams, needle) : undefined;
  const hitClass =
    'flex w-full items-center gap-2 rounded-button px-2 py-1.5 text-left hover:bg-surface-hover-bg';
  const sections = found && [
    {
      key: 'exams',
      label: m.question_ui_exams(),
      rows: found.exams.map((hit) => (
        <button
          className={hitClass}
          key={hit.exam.id}
          onClick={() => {
            onFilter('');
            const only = soleTopic(hit.exam);
            if (only) onTopic(only.id);
            else reveal(hit.exam.id);
          }}
          type="button"
        >
          <span className="min-w-0 flex-1 translate-y-px truncate">
            <Highlight needle={needle} text={hit.exam.label} />
          </span>
          <span className="shrink-0 text-fg-muted text-xs">
            {topicCount(hit.exam)}
          </span>
        </button>
      )),
    },
    {
      key: 'subjects',
      label: m.question_ui_subjects(),
      rows: found.subjects.map((hit) => (
        <button
          className={hitClass}
          key={hit.subject.id}
          onClick={() => {
            onFilter('');
            reveal(hit.exam.id, hit.subject.id);
          }}
          type="button"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate">
              <Highlight needle={needle} text={hit.subject.label} />
            </span>
            <span className="t-meta block truncate text-fg-muted">
              {hit.exam.label}
            </span>
          </span>
          <span className="shrink-0 font-semibold text-fg-muted text-xs">
            {hit.subject.topics.reduce((sum, item) => sum + item.total, 0)}
          </span>
        </button>
      )),
    },
    {
      key: 'topics',
      label: m.question_ui_topics(),
      rows: found.topics.map((hit) => {
        // The topic's exam and subject, unless the exam hides its one subject.
        const trail = [
          hit.exam.label,
          !soleSubject(hit.exam) && hit.subject.label,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <button
            aria-current={hit.item.id === topicId ? 'page' : undefined}
            className={cn(
              hitClass,
              hit.item.id === topicId && 'bg-surface-hover-bg'
            )}
            key={hit.item.id}
            onClick={() => {
              onFilter('');
              reveal(hit.exam.id, hit.subject.id);
              onTopic(hit.item.id);
            }}
            type="button"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                <Highlight needle={needle} text={hit.item.label} />
              </span>
              <span className="t-meta block truncate text-fg-muted">
                {trail}
              </span>
            </span>
            {count(hit.item)}
          </button>
        );
      }),
    },
  ];
  const topicRow = (item: BankTopic) => (
    <li key={item.id}>
      <button
        aria-current={item.id === topicId ? 'page' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-button px-2 py-1.5 text-left hover:bg-surface-hover-bg',
          item.id === topicId && 'bg-surface-hover-bg font-bold'
        )}
        onClick={() => onTopic(item.id)}
        type="button"
      >
        <span className="min-w-0 flex-1 translate-y-px truncate">
          {item.label}
        </span>
        {count(item)}
      </button>
      {item.id === topicId && (
        <TopicSquares
          edit={edit}
          onQuestion={onQuestion}
          questionId={questionId}
          topicId={topicId}
        />
      )}
    </li>
  );
  const subjects = (exam: BankExam) =>
    soleSubject(exam) ? (
      <ul className="flex flex-col gap-0.5">
        {exam.subjects[0].topics.map(topicRow)}
      </ul>
    ) : (
      exam.subjects.map((subject) => {
        const expanded = open.has(subject.id);
        return (
          <div key={subject.id}>
            <button
              aria-expanded={expanded}
              className="flex w-full items-center gap-1.5 rounded-button px-2 py-1.5 text-left hover:bg-surface-hover-bg"
              onClick={() => toggle(subject.id)}
              type="button"
            >
              <Icon
                className={cn(
                  'motion-accordion-chevron shrink-0 text-fg-muted',
                  !expanded && '-rotate-90'
                )}
                name="chevronDown"
                size={13}
              />
              <span className="min-w-0 flex-1 translate-y-px truncate font-semibold">
                {subject.label}
              </span>
              {!expanded && (
                <span className="shrink-0 font-semibold text-fg-muted text-xs">
                  {subject.topics.reduce((sum, item) => sum + item.total, 0)}
                </span>
              )}
            </button>
            <div
              className="motion-accordion"
              data-open={expanded}
              inert={!expanded}
            >
              <div>
                {/* A guide line under the subject's chevron; topics sit right
                    of it, indented past the subject's name. */}
                <ul className="ml-3.5 flex flex-col border-line border-l pl-3">
                  {subject.topics.map(topicRow)}
                </ul>
              </div>
            </div>
          </div>
        );
      })
    );
  return (
    <nav
      aria-label={m.question_ui_exams_and_topics()}
      className="-mt-1 flex flex-col gap-3"
    >
      {dialog ? (
        // PanelSearch pads itself for a panel; here the field lines up with
        // the dialog's title and the strips.
        <div className="-mx-2.5">
          <PanelSearch
            label={m.question_ui_find_a_topic()}
            onChange={onFilter}
            value={filter}
          />
        </div>
      ) : (
        <PanelHeading
          filter={filter}
          onFilter={onFilter}
          searchLabel={m.question_ui_find_a_topic()}
          title={m.question_ui_exams_and_topics()}
        />
      )}
      {sections ? (
        <div className="flex flex-col gap-4 pt-2">
          {sections.map(
            (section) =>
              section.rows.length > 0 && (
                <section className="flex flex-col gap-0.5" key={section.key}>
                  <h4 className="px-2 pb-1 font-bold text-fg-muted text-sm">
                    {section.label}
                  </h4>
                  {section.rows}
                </section>
              )
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {syllabus.exams.map((exam) => {
            const only = soleTopic(exam);
            const expanded = !only && open.has(exam.id);
            return (
              <ExamSection
                aria-current={only?.id === topicId ? 'page' : undefined}
                aria-expanded={only ? undefined : expanded}
                exam={exam}
                key={exam.id}
                onClick={() => (only ? onTopic(only.id) : toggle(exam.id))}
                open={expanded}
              >
                {!only && (
                  <div
                    className="motion-accordion"
                    data-open={expanded}
                    inert={!expanded}
                  >
                    <div>
                      <div className="flex flex-col gap-0.5 pt-0.5 pb-2">
                        {subjects(exam)}
                      </div>
                    </div>
                  </div>
                )}
              </ExamSection>
            );
          })}
        </div>
      )}
      {(sections
        ? sections.every((section) => !section.rows.length)
        : !syllabus.exams.length) && (
        <p className="px-2 text-fg-muted">
          {needle
            ? m.question_ui_no_topics_match()
            : m.question_ui_no_syllabi_have_been_published_yet()}
        </p>
      )}
    </nav>
  );
}

/**
 * The open topic's questions as numbered squares that jump to the question:
 * result colours in view mode; in edit mode plain, with a corner tick once
 * reviewed. The current question is ringed.
 */
function TopicSquares({
  topicId,
  questionId,
  edit,
  onQuestion,
}: {
  topicId: string;
  questionId: string;
  edit: boolean;
  onQuestion: (id: string) => void;
}) {
  const { data, error, refetch } = useQuery({
    ...bankSummaryQuery(topicId),
    meta: { errorBoundary: false },
  });
  if (error)
    return (
      <InlineErrorState
        className="py-2 pl-2"
        errorId={unexpectedErrorId(error)}
        message={describeError(error).title}
        onRetry={() => void refetch()}
      />
    );
  if (!data) return <Skeleton className="mx-2 my-2 h-14" />;
  return (
    <ol
      aria-label={m.question_ui_questions()}
      className="grid grid-cols-[repeat(auto-fill,minmax(1.75rem,1fr))] gap-1.5 px-2 pt-2 pb-3"
    >
      {data.questions.map((q, i) => {
        const outcome = edit
          ? 'none'
          : outcomeOf({
              awarded: q.score === null ? null : q.score * q.marks,
              id: q.id,
              marks: q.marks,
              number: i + 1,
            });
        const reviewed = edit && q.reviewedAt !== null;
        return (
          <li key={q.id}>
            <button
              aria-current={q.id === questionId ? 'true' : undefined}
              aria-label={
                reviewed
                  ? `${squareLabel(outcome, i + 1)}, ${m.question_ui_reviewed()}`
                  : squareLabel(outcome, i + 1)
              }
              className={cn(
                'relative grid h-7 w-full place-items-center rounded-md font-bold text-[#1d2330] text-[0.72rem] hover:brightness-95',
                OUTCOME_FILL[outcome],
                outcome === 'none' &&
                  'text-fg-secondary hover:bg-surface-dark-hover-bg hover:brightness-100',
                q.id === questionId &&
                  'ring-2 ring-action-accent ring-offset-2 ring-offset-surface'
              )}
              onClick={() => onQuestion(q.id)}
              type="button"
            >
              {i + 1}
              {reviewed && (
                <Icon
                  className="absolute -top-1 -right-1 size-3.5 rounded-full bg-surface text-tint-success-fg"
                  name="check"
                />
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Review status, then Undo review or Mark reviewed, Comment and Edit on one row. */
function ReviewBar({
  detail,
  reviewing,
  onReview,
  onComment,
  onEdit,
}: {
  detail: BankDetail;
  reviewing: boolean;
  onReview: () => void;
  onComment: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="grid gap-2 border-divider border-t pt-3 sm:flex sm:items-center">
      <p className="t-meta flex items-center gap-1.5 text-fg-muted sm:mr-auto">
        {detail.reviewedAt ? (
          <>
            <Icon
              className="shrink-0 text-solid-success"
              name="circleCheck"
              size={14}
            />
            <span>
              {detail.reviewerName
                ? m.question_ui_reviewed_by({ name: detail.reviewerName })
                : m.question_ui_reviewed()}
              {' · '}
              <time dateTime={detail.reviewedAt}>
                {new Date(detail.reviewedAt).toLocaleDateString(getLocale())}
              </time>
            </span>
          </>
        ) : (
          m.question_ui_not_reviewed()
        )}
      </p>
      <div className="flex justify-end gap-0.5 sm:gap-1.5">
        <Button
          className="h-7 gap-1 px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
          disabled={reviewing}
          iconLeft={detail.reviewedAt ? 'x' : 'check'}
          onClick={onReview}
          rounded="large"
          size="sm"
          variant={detail.reviewedAt ? 'danger-light' : 'ghost-hover'}
        >
          {detail.reviewedAt
            ? m.question_ui_undo_review()
            : m.question_ui_mark_reviewed()}
        </Button>
        <Button
          className="h-7 gap-1 px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
          iconLeft="comment"
          onClick={onComment}
          rounded="large"
          size="sm"
          variant="ghost-hover"
        >
          {m.question_ui_comment()}
        </Button>
        <Button
          aria-label={m.question_ui_edit_question()}
          className="h-7 gap-1 px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
          iconLeft="pencil"
          onClick={onEdit}
          rounded="large"
          size="sm"
          variant="accent"
        >
          {m.question_ui_edit()}
        </Button>
      </div>
    </div>
  );
}

/**
 * /qb with no topic open: in View mode, the topics the learner has answered in.
 * Started topics: the latest as a progress map with Continue, the rest as
 * rows with a small trail. Finished topics: a divider list with Summary (the
 * topic's top). The map leads with the finished topic a finish toast's Go
 * check names, and with the latest finished when none is started. Without
 * any, a placeholder map with its notice board and suggested topics (Choose a
 * topic in Edit mode); phones pick topics in the page.
 */
function BankLanding({
  aside,
  exams,
  finishedTopic,
  view,
  onOpen,
  onStart,
}: {
  /** At the right of the Continue title. */
  aside?: ReactNode;
  exams: BankExam[];
  finishedTopic?: string;
  view: boolean;
  onOpen: (topicId: string, next: string | null) => void;
  onStart: (topicId: string) => void;
}) {
  const { data, isPending } = useQuery({
    ...bankProgressQuery(),
    enabled: view,
  });
  let progress: ReactNode = null;
  if (view && isPending) progress = <SkeletonList count={3} rowHeight={52} />;
  else if (view && data?.topics.length) {
    // The server lists the most recently answered first.
    const going = data.topics.filter(isStarted);
    const finished = data.topics.filter((topic) => !topic.nextQuestionId);
    const lead =
      finished.find((topic) => topic.topicId === finishedTopic) ??
      going[0] ??
      finished[0];
    const listed = finished.filter((topic) => topic !== lead);
    // Flex, not grid: a grid track would widen to the scrolling map's full width.
    progress = (
      <div className="flex flex-col gap-12">
        <ContinueSection
          aside={aside}
          exams={exams}
          lead={lead}
          onOpen={onOpen}
          others={going.filter((topic) => topic !== lead)}
        />
        {listed.length > 0 && (
          <section>
            <h2 className="t-card-title mb-3">{m.question_ui_finished()}</h2>
            <div className="flex flex-col">
              {listed.map((topic) => (
                <ProgressRow
                  className="grid-cols-[minmax(0,1fr)_auto]"
                  key={topic.topicId}
                  onClick={() => onOpen(topic.topicId, null)}
                >
                  <TopicName exams={exams} topic={topic} />
                  <time
                    className="hidden text-right text-fg-secondary text-sm sm:block"
                    dateTime={topic.lastAnsweredAt}
                  >
                    {new Date(topic.lastAnsweredAt).toLocaleDateString(
                      getLocale(),
                      {
                        day: 'numeric',
                        month: 'short',
                      }
                    )}
                  </time>
                </ProgressRow>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      {progress}
      {!progress && view && data && (
        <>
          <PlaceholderTrailMap />
          <SuggestedTopics exams={exams} onStart={onStart} />
        </>
      )}
      {!progress && !(view && data) && (
        <p className="text-fg-muted">{m.question_ui_choose_a_topic()}</p>
      )}
    </div>
  );
}

/** The first topic with questions in each exam, at most four, for a learner
 * who has answered nothing yet. */
function SuggestedTopics({
  exams,
  onStart,
}: {
  exams: BankExam[];
  onStart: (topicId: string) => void;
}) {
  const suggested = exams
    .flatMap((exam) => {
      for (const subject of exam.subjects) {
        const topic = subject.topics.find((item) => item.total > 0);
        if (topic) return [{ exam, subject, topic }];
      }
      return [];
    })
    .slice(0, 4);
  if (!suggested.length) return null;
  return (
    <section>
      <h3 className="mb-1 font-bold text-fg-muted text-sm">
        {m.question_ui_suggested_topics()}
      </h3>
      {suggested.map(({ exam, subject, topic }) => {
        const path = topicPath(exam, subject, topic);
        const count =
          topic.total === 1
            ? m.question_ui_one_question()
            : m.question_ui_question_count({ count: topic.total });
        return (
          <div
            className="flex items-center justify-between gap-4 border-divider border-t py-3 last:border-b"
            key={topic.id}
          >
            <div className="min-w-0">
              <div className="truncate font-semibold text-fg">
                {path.at(-1)}
              </div>
              <div className="truncate text-fg-muted text-xs">
                {[...path.slice(0, -1), count].join(' · ')}
              </div>
            </div>
            <UnderlineLink onClick={() => onStart(topic.id)}>
              {m.common_start()}
            </UnderlineLink>
          </div>
        );
      })}
    </section>
  );
}

type StartedTopic = BankTopicProgress & { nextQuestionId: string };
const isStarted = (topic: BankTopicProgress): topic is StartedTopic =>
  topic.nextQuestionId !== null;

/** A progress row's visible names by its exam's shape, the topic last. */
function progressPath(exams: BankExam[], topic: BankTopicProgress) {
  const exam = exams.find((item) => item.id === topic.examId);
  const labels = {
    subject: { label: topic.subjectLabel },
    topic: { label: topic.topicLabel },
  };
  return exam
    ? topicPath(exam, labels.subject, labels.topic)
    : [topic.examLabel, topic.subjectLabel, topic.topicLabel];
}

/** The landing's map: the lead topic with Continue (or Summary once it is
 * finished, with its finish animation), then the other started topics. */
function ContinueSection({
  aside,
  exams,
  lead: latest,
  others,
  onOpen,
}: {
  aside?: ReactNode;
  exams: BankExam[];
  lead: BankTopicProgress;
  others: StartedTopic[];
  onOpen: (topicId: string, next: string | null) => void;
}) {
  const latestPath = progressPath(exams, latest);
  const next = latest.nextQuestionId;
  // The title and the topic's name open what the accent link opens.
  const link = next
    ? linkOptions({
        params: { questionId: next, topicId: latest.topicId },
        to: '/qb/$topicId/$questionId',
      })
    : linkOptions({
        params: { topicId: latest.topicId },
        to: '/qb/$topicId/summary',
      });
  const linkClass = 'underline-offset-4 hover:underline';
  return (
    <section>
      {/* The trail map stays edge to edge. */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="t-large-card-title">
            <Link {...link} className={linkClass}>
              {next ? m.question_ui_continue() : m.question_ui_topic_finished()}
            </Link>
          </h2>
          <p className="t-meta mb-1 text-fg-muted">
            {latestPath.slice(0, -1).join(' · ')}
          </p>
        </div>
        {aside}
      </div>
      <TrailMap
        answeredPositions={latest.answeredPositions}
        finishKey={finishKey('topic', latest.topicId, latest.total)}
        key={latest.topicId}
        lastAnsweredPosition={latest.lastAnsweredPosition}
        nextQuestionId={next}
        onOpen={(questionId) => onOpen(latest.topicId, questionId)}
        questionIds={latest.questionIds}
        topicId={latest.topicId}
      />
      <div className="mt-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h3 className="t-large-card-title">
            <Link {...link} className={linkClass}>
              {latestPath.at(-1)}
            </Link>
          </h3>
          <p className="mt-1 text-fg-muted text-sm">
            {m.question_ui_progress_line({
              answered: latest.answered,
              correct: latest.correct,
              total: latest.total,
            })}
          </p>
        </div>
        <UnderlineLink accent onClick={() => onOpen(latest.topicId, next)}>
          {next
            ? m.question_ui_continue_at({
                position: latest.questionIds.indexOf(next) + 1,
              })
            : m.question_ui_summary()}
        </UnderlineLink>
      </div>
      {others.length > 0 && (
        // Rows lay out by the list's width: the side panel narrows it on wide
        // screens. Phones put the bar and count on a second line.
        <div className="@container mt-8 flex flex-col">
          <h3 className="mb-1 font-bold text-fg-muted text-sm">
            {m.question_ui_other_topics()}
          </h3>
          {others.map((topic) => (
            <ProgressRow
              className="@sm:grid-cols-[minmax(0,3fr)_minmax(150px,2fr)_4.5rem] grid-cols-[minmax(0,1fr)_auto]"
              key={topic.topicId}
              onClick={() => onOpen(topic.topicId, topic.nextQuestionId)}
            >
              <TopicName exams={exams} topic={topic} />
              <div
                aria-hidden
                className="@sm:row-start-auto row-start-2 h-2 overflow-hidden rounded-full bg-tint-accent-1"
              >
                <div
                  className="h-full rounded-full bg-action-accent"
                  style={{ width: `${(topic.answered / topic.total) * 100}%` }}
                />
              </div>
              <div className="@sm:row-start-auto row-start-2 text-right text-fg-secondary text-sm">
                {m.study_of({ done: topic.answered, total: topic.total })}
              </div>
            </ProgressRow>
          ))}
        </div>
      )}
    </section>
  );
}

/** A whole-row link on the landing, its divider hidden around the hover. */
function ProgressRow({
  className,
  onClick,
  children,
}: {
  className: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={cn(
        'relative -mx-3 grid w-[calc(100%+1.5rem)] items-center gap-x-4 gap-y-1.5 rounded-button px-3 py-3 text-left hover:bg-surface-hover-bg',
        'before:absolute before:inset-x-3 before:top-0 before:border-divider before:border-t first-of-type:before:hidden hover:before:hidden [&:hover+button]:before:hidden',
        className
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function TopicName({
  exams,
  topic,
}: {
  exams: BankExam[];
  topic: BankTopicProgress;
}) {
  const path = progressPath(exams, topic);
  return (
    <div className="min-w-0">
      <div className="truncate font-semibold text-fg">{path.at(-1)}</div>
      {path.length > 1 && (
        <div className="truncate text-fg-muted text-xs">
          {path.slice(0, -1).join(' · ')}
        </div>
      )}
    </div>
  );
}

/** A failed page load between loaded questions. */
function BankError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <InlineErrorState
      className="py-6"
      errorId={unexpectedErrorId(error)}
      message={describeError(error).title}
      onRetry={onRetry}
    />
  );
}

function BankComment({ id, onClose }: { id: string; onClose: () => void }) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof commentSchema>>({
    defaultValues: { text: '' },
    resolver: zodResolver(commentSchema),
  });
  const { mutateAsync, isPending } = useMutation({
    mutationFn: (body: z.infer<typeof commentSchema>) =>
      api.post<void>(
        '/bank/questions/' + encodeURIComponent(id) + '/comments',
        body
      ),
  });
  return (
    <SimpleDialog
      action={
        <Button
          disabled={isPending}
          rounded="large"
          size="lg"
          type="submit"
          variant="accent"
        >
          {m.question_ui_send_comment()}
        </Button>
      }
      onClose={onClose}
      onSubmit={handleSubmit(async (body) => {
        try {
          await mutateAsync(body);
          onClose();
        } catch (error) {
          // The comment stays in the field for a manual retry.
          userToast({
            description: error instanceof Error ? error.message : undefined,
            title: m.question_ui_comment_failed(),
            variant: 'error',
          });
        }
      })}
      open
      title={m.question_ui_comment_on_this_question()}
    >
      <Textarea
        aria-label={m.question_ui_comment()}
        {...register('text')}
        maxLength={commentBankQuestionBodyTextMax}
      />
      <InputError>{errors.text?.message}</InputError>
    </SimpleDialog>
  );
}
