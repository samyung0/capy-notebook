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
  copyBankQuestionsBodyQuestionIdsMax as COPY_MAX,
  commentBankQuestionBodyTextMax,
} from '@/api/gen/validators';
import type { BankTopicProgress } from '@/api/types';
import {
  FilterPopover,
  type FilterSection,
  toggleValue,
} from '@/components/app/ListToolbar';
import { PageHeader, Panel, PanelHeader } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/Drawer';
import { Skeleton, SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Input, InputError } from '@/components/ui/Input';
import {
  PageFloatingBar,
  PageFloatingBarButton,
} from '@/components/ui/PageFloatingBar';
import { Tabs } from '@/components/ui/Tabs';
import { Textarea } from '@/components/ui/TextArea';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { userToast } from '@/components/ui/userToast';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { relativeTime } from '@/features/materials/MaterialListCard';
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
  storeBankEdit,
  topicPath,
  uploadBankAsset,
} from '@/features/questions/bank';
import {
  type SyllabusHit,
  searchSyllabus,
} from '@/features/questions/bankSearch';
import { CopyToQuizDialog } from '@/features/questions/CopyToQuizDialog';
import { ExamPicker, ExamStrip } from '@/features/questions/ExamPicker';
import { answerLabels } from '@/features/questions/editorFields';
import {
  QuestionListRow,
  statusLabels,
} from '@/features/questions/QuestionListRow';
import { TopicSummary } from '@/features/questions/TopicSummary';
import { MiniTrail, TrailMap } from '@/features/questions/trailMap/TrailMap';
import {
  type LearnerQuestion,
  QUESTION_TYPES,
  type Question,
} from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { type Crumb, QuizPageHeader } from '@/features/quizzes/QuizPage';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { CopyError, describeError } from '@/lib/errors';
import { holdPosition, scrollSettled } from '@/lib/scrollAnchor';
import { scrollIntoViewWithMotion } from '@/lib/scrollIntoViewWithMotion';
import { useDebounced } from '@/lib/useDebounced';
import { useMediaQuery } from '@/lib/useMediaQuery';

const QuestionDialog = lazy(() =>
  import('@/features/questions/QuestionDialog').then((module) => ({
    default: module.QuestionDialog,
  }))
);
const commentSchema = z.object({
  text: z.string().trim().min(1).max(commentBankQuestionBodyTextMax),
});
/** Questions per load; the window grows by this many as the reader nears its end. */
const PAGE = 10;

/**
 * Question bank: every question of the chosen topic in the main panel; exams,
 * topics and the topic's question list in the right column (a floating bar
 * and bottom sheet on phones), where Clone picks questions for Copy to quiz.
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
  const [showTopics, setShowTopics] = useState(!topicId);
  const [navOpen, setNavOpen] = useState(false);
  // From lg the side panel shows the same nav, so a sheet left open while
  // the window widens closes instead of covering the page.
  const lg = useMediaQuery('(min-width: 1024px)');
  useEffect(() => {
    if (lg) setNavOpen(false);
  }, [lg]);
  const [topicFilter, setTopicFilter] = useState('');
  const [filter, setFilter] = useState('');
  const [unreviewed, setUnreviewed] = useState(false);
  const [types, setTypes] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  // The list opens on the page holding this question: the URL's question when
  // the topic or a filter changes, or one the loaded pages do not hold.
  const [anchor, setAnchor] = useState(questionId);
  // Clone turns the panel's question list into a picker for Copy to quiz;
  // picks keep their rows so they survive filtering and copy in list order.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<BankRow[]>([]);
  const selected = picked.map((row) => row.id);
  const [copying, setCopying] = useState(false);
  // The panel's back arrow lists every exam even while a topic is open.
  const [allExams, setAllExams] = useState(false);
  const [shownTopic, setShownTopic] = useState(topicId);
  if (shownTopic !== topicId) {
    setShownTopic(topicId);
    setAllExams(false);
    setFilter('');
    setTypes([]);
    setStatuses([]);
    setAnchor(questionId);
    setSelecting(false);
    setPicked([]);
  }
  const [editing, setEditing] = useState<BankDetail | null>(null);
  const [conflict, setConflict] = useState(false);
  const [commentFor, setCommentFor] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const {
    data: syllabus,
    error: syllabusError,
    isPending: syllabusPending,
    fetchStatus,
  } = useQuery({ ...bankSyllabusQuery(), meta: { errorBoundary: false } });
  const mode = syllabus?.editor && search.mode === 'edit' ? 'edit' : 'view';
  // Learners' results lead the list rows in view mode only.
  const { data: results, error: resultsError } = useQuery({
    ...bankMarksQuery(topicId),
    enabled: Boolean(topicId) && mode === 'view',
    meta: { errorBoundary: false },
  });
  const marks = mode === 'view' && !resultsError ? results?.marks : undefined;
  const {
    data: topicSummary,
    error: summaryError,
    isPending: summaryPending,
  } = useQuery({
    ...bankSummaryQuery(topicId),
    enabled: summary,
    meta: { errorBoundary: false },
  });
  // The summary's finished date and next topic come from the landing's list.
  const { data: progress } = useQuery({
    ...bankProgressQuery(),
    enabled: summary,
    meta: { errorBoundary: false },
  });
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
    isFetchingPreviousPage,
    fetchNextPage,
    fetchPreviousPage,
  } = useInfiniteQuery({
    ...bankListQuery(topicId, listFilters, anchor),
    meta: { errorBoundary: false },
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
  function toggleQuestion(row: BankRow) {
    if (selected.includes(row.id))
      setPicked(picked.filter((item) => item.id !== row.id));
    else if (selected.length < COPY_MAX) setPicked([...picked, row]);
    else
      userToast({
        title: m.question_ui_copy_limit({ count: COPY_MAX }),
        variant: 'warning',
      });
  }
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
    setShowTopics(false);
    setNavOpen(false);
    void navigate({
      params: { topicId: id },
      search: modeSearch,
      to: '/qb/$topicId',
    });
  }
  /** From the landing: Continue opens the next question, Summary the topic's summary. */
  function openProgress(id: string, next: string | null) {
    setShowTopics(false);
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
    // Picking questions keeps the phone sheet open between picks.
    if (!selecting) setNavOpen(false);
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

  /**
   * Opens an exam in the side panel, or the exam list, on the current page.
   * A single-topic exam opens straight on its questions.
   */
  function openExam(exam: string | undefined) {
    const picked = syllabus?.exams.find((item) => item.id === exam);
    const only = picked && soleTopic(picked);
    setAllExams(!exam);
    if (only) topic(only.id);
    else void navigate({ search: { ...modeSearch, exam }, to: '.' });
  }

  const topicsShown = showTopics || !topicId;
  // The bottom sheet swaps the panel title for Topics / Questions tabs, so the
  // other list is one tap away without closing the sheet.
  const navTabs = (
    <Tabs
      className="inset-shadow-none min-w-0 flex-1"
      onChange={(value) => setShowTopics(value === 'topics')}
      tabs={[
        { label: m.question_ui_exams(), value: 'topics' },
        ...(topicId
          ? [{ label: m.question_ui_questions(), value: 'questions' }]
          : []),
      ]}
      value={topicsShown ? 'topics' : 'questions'}
    />
  );
  const nav = (tabs?: ReactNode) =>
    syllabus ? (
      topicsShown ? (
        <TopicTree
          edit={mode === 'edit'}
          // A single-topic exam has no tree of its own, so its topic shows
          // the exam list.
          examId={
            allExams
              ? undefined
              : (search.exam ??
                (place && !soleTopic(place.exam) ? place.exam.id : undefined))
          }
          filter={topicFilter}
          onAllExams={() => openExam(undefined)}
          onExam={openExam}
          onFilter={setTopicFilter}
          onTopic={topic}
          syllabus={syllabus}
          tabs={tabs}
          topicId={topicId}
        />
      ) : (
        <TopicQuestions
          edit={mode === 'edit'}
          filter={filter}
          filters={filters}
          // A failed page shows the list error with Try again; the panel's
          // ends stop loading until then.
          hasEarlier={hasPreviousPage && !listError}
          hasMore={hasNextPage && !listError}
          label={path?.at(-1) ?? ''}
          loadingEarlier={isFetchingPreviousPage}
          loadingMore={isFetchingNextPage}
          onBack={() => setShowTopics(true)}
          onCancelSelect={() => {
            setSelecting(false);
            setPicked([]);
          }}
          onCopy={() => {
            setNavOpen(false);
            setCopying(true);
          }}
          onEarlier={() => void fetchPreviousPage(joinFetch)}
          onFilter={refilter(setFilter)}
          onMore={() => void fetchNextPage(joinFetch)}
          onQuestion={(row) => {
            if (selecting) toggleQuestion(row);
            select(row.id);
          }}
          onResetFilters={() => {
            setTypes([]);
            setStatuses([]);
            setAnchor(questionId);
          }}
          onSelect={() => setSelecting(true)}
          onUnreviewed={refilter(setUnreviewed)}
          questionId={questionId}
          results={mode === 'view' && !resultsError ? (marks ?? {}) : undefined}
          reviewedCount={place?.item.reviewed ?? 0}
          rows={rows}
          selected={selecting ? selected : undefined}
          tabs={tabs}
          total={place?.item.total ?? 0}
          unreviewed={unreviewed}
        />
      )
    ) : syllabusPending ? (
      <SkeletonList count={8} rowHeight={28} />
    ) : null;

  let body: ReactNode;
  if (fetchStatus === 'paused') body = <QueryPausedState />;
  else if (syllabusPending)
    body = (
      <div aria-label={m.a11y_loading()} role="status">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  else if (syllabusError)
    body = (
      <BankError
        error={syllabusError}
        onRetry={() =>
          void client.invalidateQueries({
            queryKey: bankSyllabusQuery().queryKey,
          })
        }
      />
    );
  else if (!topicId)
    body = (
      <BankLanding
        exams={syllabus.exams}
        onOpen={openProgress}
        view={mode === 'view'}
      />
    );
  else if (summary) {
    if (summaryError)
      body = (
        <BankError
          error={summaryError}
          onRetry={() =>
            void client.invalidateQueries({
              queryKey: bankSummaryQuery(topicId).queryKey,
            })
          }
        />
      );
    else if (summaryPending) body = <Skeleton className="h-64 w-full" />;
    else
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
          topicLabel={place?.item.label ?? ''}
        />
      );
  } else if (listError)
    body = (
      <BankError
        error={listError}
        onRetry={() =>
          void client.invalidateQueries({ queryKey: bankTopicKey(topicId) })
        }
      />
    );
  else if (listPending || listStale)
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
    <div className="flex h-full min-h-0 flex-col gap-1.5 sm:gap-2.5 lg:flex-row">
      <div className="order-first flex shrink-0 flex-col gap-2.5 lg:order-last lg:h-full lg:w-(--top-inset-bar-width)">
        <TopInsetBar />
        <Panel
          className="hidden min-h-0 flex-1 lg:flex"
          sectionClassName="scroll-fade-y h-full px-2 py-5 [--scroll-fade-bottom-padding:--spacing(5)]"
        >
          {nav()}
        </Panel>
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <Panel
          className="min-h-0 flex-1 rounded-button lg:rounded-card-xl"
          scrollRef={scrollRef}
          sectionClassName="h-full gap-0"
        >
          {topicId ? (
            <>
              <QuizPageHeader
                actions={
                  summary ? (
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
                          : m.question_ui_edit_mode()}
                      </Button>
                    )
                  )
                }
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
              />
              <div className="px-4 pt-8 pb-28 sm:px-6 lg:px-10 lg:pb-10 xl:px-16">
                <div className="max-w-3xl">{body}</div>
              </div>
            </>
          ) : (
            <>
              <PageHeader
                actions={
                  syllabus?.editor && (
                    <Button
                      iconLeft={mode === 'edit' ? 'view' : 'pencil'}
                      onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}
                      rounded="large"
                      size="sm"
                    >
                      {mode === 'edit'
                        ? m.question_ui_view_mode()
                        : m.question_ui_edit_mode()}
                    </Button>
                  )
                }
                className="justify-between md:flex-1"
                showTopBar={false}
                title={
                  <div>
                    <h1 className="t-page-title">
                      {m.question_ui_question_bank()}
                    </h1>
                    <p className="t-subtitle mt-1 text-fg-muted">
                      {m.question_ui_bank_hint()}
                    </p>
                  </div>
                }
              />
              {/* Full panel width: the map and the lists line up with Edit mode. */}
              <div className="px-4 pt-6 pb-28 sm:px-6 lg:pb-10">{body}</div>
            </>
          )}
        </Panel>
        {/* Without the side panel (below lg) it becomes a floating bar and a
            bottom sheet, as in WorkspaceOpen's single-column layout. */}
        {syllabus && (
          <PageFloatingBar
            aria-label={m.question_ui_bank_navigation()}
            className="lg:hidden"
            open={!navOpen}
          >
            <PageFloatingBarButton
              icon="book"
              label={m.question_ui_exams()}
              onClick={() => {
                setShowTopics(true);
                setNavOpen(true);
              }}
            />
            {topicId && (
              <PageFloatingBarButton
                icon="list"
                label={m.question_ui_questions()}
                onClick={() => {
                  setShowTopics(false);
                  setNavOpen(true);
                }}
              />
            )}
          </PageFloatingBar>
        )}
      </div>
      <Drawer
        onOpenChange={setNavOpen}
        open={navOpen}
        showSwipeHandle
        swipeDirection="down"
      >
        <DrawerContent
          style={{ '--drawer-height': '70dvh' } as React.CSSProperties}
        >
          <DrawerTitle className="sr-only">
            {m.question_ui_bank_navigation()}
          </DrawerTitle>
          <div className="min-h-0 overflow-auto px-3 pb-6">{nav(navTabs)}</div>
        </DrawerContent>
      </Drawer>
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
      {copying && (
        <CopyToQuizDialog
          onClose={() => setCopying(false)}
          onCopied={() => {
            setCopying(false);
            setSelecting(false);
            setPicked([]);
          }}
          questionIds={[...picked]
            .sort((a, b) => a.position - b.position)
            .map((row) => row.id)}
          topicLabel={place?.item.label ?? ''}
        />
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
    if (!nearEnd || isFetching || error) return;
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
            className="h-7 gap-1 px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
            iconLeft="refresh"
            iconLeftClassName="size-3.5 sm:size-3.75"
            onClick={() => {
              reset();
              setAnswers({});
            }}
            rounded="large"
            size="sm"
            variant="ghost-hover"
          >
            {m.question_ui_answer_again()}
          </Button>
        ) : (
          <Button
            className="h-7 gap-1 px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
            disabled={isPending}
            iconLeft="check"
            iconLeftClassName="size-3.5 sm:size-3.75"
            onClick={() => check(answers)}
            rounded="large"
            size="sm"
            variant="accent"
          >
            {m.question_ui_check_answer()}
          </Button>
        )}
      </div>
    </>
  );
}

/** Whether the element is within the root (default the viewport) grown by
 * `margin`; an ancestor scroller still clips it. The observer reports a frame
 * late, so a new `key` (content moved the element) reads false until then. */
function useNear(
  ref: RefObject<Element | null>,
  margin: string,
  root?: RefObject<Element | null>,
  key?: unknown
) {
  const [seen, setSeen] = useState({ key, near: false });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setSeen({ key, near: entry.isIntersecting }),
      { root: root?.current, rootMargin: margin }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, margin, root, key]);
  return seen.key === key && seen.near;
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
  tabs,
  leading,
  filter,
  onFilter,
  searchLabel,
}: {
  title: string;
  /** Shown in place of the title, as in the bottom sheet. */
  tabs?: ReactNode;
  leading?: ReactNode;
  filter: string;
  onFilter: (value: string) => void;
  searchLabel: string;
}) {
  const [searching, setSearching] = useState(filter !== '');
  const searchButton = (
    <ToolbarButton
      className="mr-0.5 size-7"
      label={searchLabel}
      onClick={() => setSearching(true)}
    >
      <Icon name="search" />
    </ToolbarButton>
  );
  // Both states share one height, so opening the search moves nothing.
  return (
    <div className={cn('grid items-center', tabs ? 'h-10' : 'h-9')}>
      {searching ? (
        <div>
          <Input
            actionCallback={() => {
              onFilter('');
              setSearching(false);
            }}
            actionClassName="p-1.5 text-fg-muted"
            actionIcon="x"
            actionLabel={m.question_ui_close_search()}
            aria-label={searchLabel}
            autoFocus
            className="py-0"
            leftIcon="search"
            maxLength={bankQuestionsQueryQMax}
            onChange={(event) => onFilter(event.target.value)}
            placeholder={searchLabel}
            size="sm"
            value={filter}
            wrapperClassName="h-9 w-full text-sm"
          />
        </div>
      ) : tabs ? (
        // The divider runs under the search button too, as in the workspace
        // panels' tab row.
        <div className="inset-shadow-[0_-1px_var(--color-divider)] flex h-full items-center gap-1">
          {leading}
          {tabs}
          {searchButton}
        </div>
      ) : (
        <PanelHeader actions={searchButton} leading={leading} title={title} />
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
 * Every exam as a cover strip until one is open (the URL's `exam`, or the
 * open topic's exam), then that exam's switcher and its subjects with indented
 * topics; subjects start collapsed except the current topic's. A search lists
 * exams and topics from every exam together (searchSyllabus); with an exam
 * open, its topics come first and the rest go under "In other exams".
 */
function TopicTree({
  syllabus,
  examId,
  topicId,
  edit,
  filter,
  onFilter,
  onExam,
  onAllExams,
  onTopic,
  tabs,
}: {
  syllabus: BankSyllabus;
  examId?: string;
  topicId: string;
  edit: boolean;
  filter: string;
  onFilter: (value: string) => void;
  onExam: (id: string) => void;
  /** Back to the exam list. */
  onAllExams: () => void;
  onTopic: (id: string) => void;
  tabs?: ReactNode;
}) {
  const current = syllabus.exams
    .flatMap((exam) => exam.subjects.map((subject) => ({ exam, subject })))
    .find(({ subject }) => subject.topics.some((item) => item.id === topicId));
  const [open, setOpen] = useState(
    () => new Set(current ? [current.subject.id] : [])
  );
  const exam = syllabus.exams.find((item) => item.id === examId);
  const needle = filter.trim().toLocaleLowerCase();
  const hits = needle ? searchSyllabus(syllabus.exams, needle) : [];
  const here = exam
    ? hits.filter((hit) => hit.kind === 'topic' && hit.exam.id === exam.id)
    : [];
  const away = exam ? hits.filter((hit) => hit.exam.id !== exam.id) : hits;
  const count = (item: BankTopic) => (
    <span className="shrink-0 font-semibold text-fg-muted text-xs">
      {edit ? `${item.reviewed}/${item.total}` : item.total}
    </span>
  );
  // A topic hit's exam (unless it is the open one) and subject, unless the
  // exam hides its one subject.
  const hitTrail = (hit: SyllabusHit & { kind: 'topic' }) =>
    [
      hit.exam.id !== exam?.id && hit.exam.label,
      !soleSubject(hit.exam) && hit.subject.label,
    ]
      .filter(Boolean)
      .join(' · ');
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
    </li>
  );
  const hitRow = (hit: SyllabusHit) =>
    hit.kind === 'exam' ? (
      // Spaced like the exam list (12px apart, flush with the heading).
      <div
        className={cn('py-[5px] first:pt-0', !tabs && 'mx-3')}
        key={hit.exam.id}
      >
        <ExamStrip
          exam={hit.exam}
          onClick={() => {
            onFilter('');
            onExam(hit.exam.id);
          }}
        />
      </div>
    ) : (
      <button
        aria-current={hit.item.id === topicId ? 'page' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-button px-2 py-1.5 text-left hover:bg-surface-hover-bg',
          hit.item.id === topicId && 'bg-surface-hover-bg'
        )}
        key={hit.item.id}
        onClick={() => {
          setOpen((prev) => new Set(prev).add(hit.subject.id));
          onTopic(hit.item.id);
        }}
        type="button"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            <Highlight needle={needle} text={hit.item.label} />
          </span>
          {hitTrail(hit) && (
            <span className="t-meta block truncate text-fg-muted">
              {hitTrail(hit)}
            </span>
          )}
        </span>
        {count(hit.item)}
      </button>
    );
  return (
    <nav
      aria-label={m.question_ui_exams_and_topics()}
      className={cn('flex flex-col gap-3', !tabs && '-mt-1')}
    >
      <PanelHeading
        filter={filter}
        leading={
          exam && (
            <ToolbarButton
              label={m.question_ui_all_exams()}
              onClick={onAllExams}
            >
              <Icon className="-translate-y-px" name="navigationBack" />
            </ToolbarButton>
          )
        }
        onFilter={onFilter}
        searchLabel={m.question_ui_find_a_topic()}
        tabs={tabs}
        title={m.question_ui_exams_and_topics()}
      />
      {exam && (
        <div className={cn(!tabs && 'mx-3')}>
          <ExamPicker exam={exam} exams={syllabus.exams} onPick={onExam} />
        </div>
      )}
      {needle ? (
        <div className="flex flex-col gap-0.5">
          {here.map(hitRow)}
          {exam && away.length > 0 && (
            <p className="t-label px-2 pt-3 pb-1 text-fg-muted uppercase">
              {m.question_ui_in_other_exams()}
            </p>
          )}
          {away.map(hitRow)}
        </div>
      ) : exam && soleSubject(exam) ? (
        <ul className="flex flex-col gap-0.5">
          {exam.subjects[0].topics.map(topicRow)}
        </ul>
      ) : exam ? (
        <div className="flex flex-col gap-0.5">
          {exam.subjects.map((subject) => {
            const expanded = open.has(subject.id);
            return (
              <div key={subject.id}>
                <button
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-1.5 rounded-button px-2 py-1.5 text-left hover:bg-surface-hover-bg"
                  onClick={() =>
                    setOpen((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(subject.id)) next.add(subject.id);
                      return next;
                    })
                  }
                  type="button"
                >
                  <Icon
                    className={cn(
                      'shrink-0 text-fg-muted transition-transform',
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
                      {subject.topics.reduce(
                        (sum, item) => sum + item.total,
                        0
                      )}
                    </span>
                  )}
                </button>
                {expanded && (
                  // A guide line under the subject's chevron; topics sit
                  // right of it, indented past the subject's name.
                  <ul className="ml-3.5 flex flex-col border-line border-l pl-3">
                    {subject.topics.map(topicRow)}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className={cn('flex flex-col gap-3', !tabs && 'mx-3')}>
          {syllabus.exams.map((item) => (
            <ExamStrip
              exam={item}
              key={item.id}
              onClick={() => onExam(item.id)}
            />
          ))}
        </div>
      )}
      {(needle ? !hits.length : !syllabus.exams.length) && (
        <p className="px-2 text-fg-muted">
          {needle
            ? m.question_ui_no_topics_match()
            : m.question_ui_no_syllabi_have_been_published_yet()}
        </p>
      )}
    </nav>
  );
}

/** The chosen topic's question list; a row scrolls the page to its question. */
function TopicQuestions({
  label,
  total,
  reviewedCount,
  rows,
  hasMore,
  hasEarlier,
  loadingMore,
  loadingEarlier,
  questionId,
  edit,
  filter,
  filters,
  unreviewed,
  results,
  selected,
  onBack,
  onCancelSelect,
  onCopy,
  onEarlier,
  onFilter,
  onMore,
  onResetFilters,
  onSelect,
  onUnreviewed,
  onQuestion,
  tabs,
}: {
  label: string;
  /** The topic's question and reviewed counts, unfiltered. */
  total: number;
  reviewedCount: number;
  /** The loaded pages' rows; more load at the end as it scrolls into view. */
  rows: BankRow[];
  hasMore: boolean;
  hasEarlier: boolean;
  loadingMore: boolean;
  loadingEarlier: boolean;
  questionId: string;
  edit: boolean;
  filter: string;
  filters: FilterSection[];
  unreviewed: boolean;
  /** View mode: answered questions' latest scores by id. */
  results?: Record<string, number>;
  /** While picking for Copy to quiz: the picked question ids. */
  selected?: string[];
  onBack: () => void;
  onCancelSelect: () => void;
  onCopy: () => void;
  onEarlier: () => void;
  onFilter: (value: string) => void;
  onMore: () => void;
  onResetFilters: () => void;
  onSelect: () => void;
  /** Replace the title and the back button, as in the bottom sheet. */
  tabs?: ReactNode;
  onUnreviewed: (value: boolean) => void;
  onQuestion: (row: BankRow) => void;
}) {
  // The viewport root also sees the ends inside the panel's or sheet's
  // scroller, which clips them, so they count once in view.
  const endRef = useRef<HTMLDivElement>(null);
  const nearEnd = useNear(endRef, '0px 0px 400px 0px');
  useEffect(() => {
    if (nearEnd && hasMore && !loadingMore) onMore();
  }, [nearEnd, hasMore, loadingMore, onMore]);

  // Rows loaded above the shown ones wait for scrolling to settle, then go in
  // with the visible rows held still (src/lib/scrollAnchor.ts).
  const listRef = useRef<HTMLOListElement>(null);
  const [firstId, setFirstId] = useState(rows[0]?.id);
  if (rows.length && !rows.some((row) => row.id === firstId))
    setFirstId(rows[0]?.id);
  const from = Math.max(
    0,
    rows.findIndex((row) => row.id === firstId)
  );
  const topId = rows[0]?.id;
  const hold = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!from) return;
    let live = true;
    void scrollSettled().then(() => {
      const element = listRef.current?.firstElementChild;
      if (!(live && element)) return;
      hold.current = holdPosition(element);
      setFirstId(topId);
    });
    return () => {
      live = false;
    };
  }, [from, topId]);
  useLayoutEffect(() => {
    hold.current?.();
    hold.current = null;
  });
  // The previous page loads at the top once the rows waiting have gone in.
  const startRef = useRef<HTMLDivElement>(null);
  const nearStart = useNear(startRef, '400px 0px 0px 0px', undefined, firstId);
  useEffect(() => {
    if (nearStart && !from && hasEarlier && !loadingEarlier) onEarlier();
  }, [nearStart, from, hasEarlier, loadingEarlier, onEarlier]);
  return (
    <nav aria-label={m.question_ui_questions()} className="flex flex-col gap-2">
      <PanelHeading
        filter={filter}
        leading={
          !tabs && (
            <ToolbarButton
              label={m.question_ui_back_to_topics()}
              onClick={onBack}
            >
              <Icon className="-translate-y-px" name="navigationBack" />
            </ToolbarButton>
          )
        }
        onFilter={onFilter}
        searchLabel={m.question_ui_find_a_question()}
        tabs={tabs}
        title={label}
      />
      <div className="flex flex-wrap items-center gap-x-1 px-3">
        {edit && (
          <>
            <Button
              aria-pressed={!unreviewed}
              onClick={() => onUnreviewed(false)}
              rounded="large"
              size="sm"
              variant={unreviewed ? 'ghost-hover' : 'gray'}
            >
              {m.action_all()} {total}
            </Button>
            <Button
              aria-pressed={unreviewed}
              onClick={() => onUnreviewed(true)}
              rounded="large"
              size="sm"
              variant={unreviewed ? 'gray' : 'ghost-hover'}
            >
              {m.question_ui_unreviewed()} {total - reviewedCount}
            </Button>
          </>
        )}
        <FilterPopover filters={filters} onResetFilters={onResetFilters} />
        {selected ? (
          <>
            <ToolbarButton
              className="-mx-1 h-7 w-auto gap-2 px-2"
              disabled={!selected.length}
              label={m.question_ui_copy_to_quiz()}
              onClick={onCopy}
            >
              <Icon name="copy" />
              <span className="whitespace-nowrap">
                {m.question_ui_copy_to_quiz()}
              </span>
            </ToolbarButton>
            <ToolbarButton
              className="size-7"
              label={m.question_ui_clear_selection()}
              onClick={onCancelSelect}
            >
              <Icon name="x" />
            </ToolbarButton>
          </>
        ) : (
          <ToolbarButton
            className="-mx-1 h-7 w-auto gap-2 px-2"
            label={m.action_clone()}
            onClick={onSelect}
          >
            <Icon name="clone" />
            <span>{m.action_clone()}</span>
          </ToolbarButton>
        )}
      </div>
      <div aria-hidden className="-mb-2" ref={startRef} />
      {(hasEarlier || from > 0) && <SkeletonList count={3} rowHeight={28} />}
      <ol className="grid gap-0.5" ref={listRef}>
        {rows.slice(from).map((row) => (
          <li key={row.id}>
            <QuestionListRow
              current={row.id === questionId}
              meta={
                edit &&
                row.reviewedAt && (
                  <span className="font-semibold text-tint-success-fg">
                    {m.question_ui_reviewed()} · {relativeTime(row.reviewedAt)}
                  </span>
                )
              }
              onClick={() => onQuestion(row)}
              result={results && (results[row.id] ?? null)}
              row={row}
              selected={selected?.includes(row.id)}
            />
          </li>
        ))}
      </ol>
      {loadingMore && <SkeletonList count={3} rowHeight={28} />}
      <div aria-hidden ref={endRef} />
    </nav>
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
          iconLeftClassName="size-3.5 sm:size-3.75"
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
          iconLeftClassName="size-3.5 sm:size-3.75"
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
          iconLeftClassName="size-3.5 sm:size-3.75"
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
 * topic's top). Without any, Choose a topic as before; phones pick topics in
 * the page.
 */
function BankLanding({
  exams,
  view,
  onOpen,
}: {
  exams: BankExam[];
  view: boolean;
  onOpen: (topicId: string, next: string | null) => void;
}) {
  const { data, error, isPending, refetch } = useQuery({
    ...bankProgressQuery(),
    enabled: view,
    meta: { errorBoundary: false },
  });
  let progress: ReactNode = null;
  if (view && isPending) progress = <SkeletonList count={3} rowHeight={52} />;
  else if (view && error)
    progress = <BankError error={error} onRetry={() => void refetch()} />;
  else if (view && data?.topics.length) {
    // The server lists the most recently answered first.
    const going = data.topics.filter(isStarted);
    const finished = data.topics.filter((topic) => !topic.nextQuestionId);
    // Flex, not grid: a grid track would widen to the scrolling map's full width.
    progress = (
      <div className="flex flex-col gap-12">
        {going.length > 0 && (
          <ContinueSection exams={exams} onOpen={onOpen} topics={going} />
        )}
        {finished.length > 0 && (
          <section>
            <h2 className="t-card-title mb-3">{m.question_ui_finished()}</h2>
            {finished.map((topic) => (
              <div
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-divider border-t py-3 last:border-b sm:grid-cols-[minmax(0,1fr)_4.5rem_auto]"
                key={topic.topicId}
              >
                <TopicName exams={exams} topic={topic} />
                <time
                  className="hidden text-fg-muted text-sm sm:block"
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
                <UnderlineLink
                  iconRight={undefined}
                  onClick={() => onOpen(topic.topicId, null)}
                >
                  {m.question_ui_summary()}
                </UnderlineLink>
              </div>
            ))}
          </section>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      {progress}
      {!progress && (
        <p className="text-fg-muted">{m.question_ui_choose_a_topic()}</p>
      )}
    </div>
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

function ContinueSection({
  exams,
  topics: [latest, ...others],
  onOpen,
}: {
  exams: BankExam[];
  topics: StartedTopic[];
  onOpen: (topicId: string, next: string | null) => void;
}) {
  const latestPath = progressPath(exams, latest);
  return (
    <section>
      <h2 className="t-card-title">{m.question_ui_continue()}</h2>
      <p className="t-meta mb-1 text-fg-muted">
        {latestPath.slice(0, -1).join(' · ')}
      </p>
      <TrailMap
        answeredPositions={latest.answeredPositions}
        lastAnsweredPosition={latest.lastAnsweredPosition}
        nextQuestionId={latest.nextQuestionId}
        onOpen={(questionId) => onOpen(latest.topicId, questionId)}
        questionIds={latest.questionIds}
        topicId={latest.topicId}
      />
      <div className="mt-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h3 className="t-large-card-title">{latestPath.at(-1)}</h3>
          <p className="mt-1 text-fg-muted text-sm">
            {m.question_ui_progress_line({
              answered: latest.answered,
              correct: latest.correct,
              total: latest.total,
            })}
          </p>
        </div>
        <UnderlineLink
          accent
          onClick={() => onOpen(latest.topicId, latest.nextQuestionId)}
        >
          {m.question_ui_continue_at({
            position: latest.questionIds.indexOf(latest.nextQuestionId) + 1,
          })}
        </UnderlineLink>
      </div>
      {others.length > 0 && (
        <div className="mt-8">
          <h3 className="mb-1 font-bold text-fg-muted text-sm">
            {m.question_ui_other_topics()}
          </h3>
          {others.map((topic) => (
            <div
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-divider border-t py-3 sm:grid-cols-[minmax(0,1fr)_minmax(150px,240px)_4.5rem_auto]"
              key={topic.topicId}
            >
              <TopicName exams={exams} topic={topic} />
              <div className="col-span-2 row-start-2 max-w-[240px] sm:col-span-1 sm:row-start-auto">
                <MiniTrail
                  answered={topic.answered}
                  topicId={topic.topicId}
                  total={topic.total}
                />
              </div>
              <div className="hidden text-right text-fg-secondary text-sm sm:block">
                {m.study_of({ done: topic.answered, total: topic.total })}
              </div>
              <UnderlineLink
                className="col-start-2 row-start-1 sm:col-start-auto sm:row-start-auto"
                iconRight={undefined}
                onClick={() => onOpen(topic.topicId, topic.nextQuestionId)}
              >
                {m.question_ui_continue()}
              </UnderlineLink>
            </div>
          ))}
        </div>
      )}
    </section>
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

function BankError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="space-y-3" role="alert">
      <p>{describeError(error).description}</p>
      <Button onClick={onRetry} variant="ghost-hover">
        {m.question_ui_try_again()}
      </Button>
    </div>
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
      footer={
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
