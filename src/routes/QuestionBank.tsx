import { zodResolver } from '@hookform/resolvers/zod';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
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
import { copyBankQuestionsBodyQuestionIdsMax as COPY_MAX } from '@/api/gen/validators';
import type { BankTopicProgress } from '@/api/types';
import {
  FilterPopover,
  type FilterSection,
  toggleValue,
} from '@/components/app/ListToolbar';
import { Panel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { FloatingToolbar } from '@/components/ui/BlockToolbar';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/Drawer';
import { Skeleton, SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Input, InputError } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/TextArea';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { userToast } from '@/components/ui/userToast';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { relativeTime } from '@/features/materials/MaterialListCard';
import {
  alignReveal,
  BANK_STATUSES,
  type BankDetail,
  type BankRow,
  type BankSyllabus,
  bankBatchQuery,
  bankMarksQuery,
  bankProgressQuery,
  bankQuestionQuery,
  bankQuestionsQuery,
  bankScore,
  bankSyllabusQuery,
  filterBankRows,
  recordBankAnswer,
  revealBankQuestion,
  uploadBankAsset,
} from '@/features/questions/bank';
import { CopyToQuizDialog } from '@/features/questions/CopyToQuizDialog';
import { answerLabels } from '@/features/questions/editorFields';
import {
  QuestionListRow,
  statusLabels,
} from '@/features/questions/QuestionListRow';
import {
  type LearnerQuestion,
  QUESTION_TYPES,
  type Question,
} from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { QuizPageHeader } from '@/features/quizzes/QuizPage';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { CopyError, describeError } from '@/lib/errors';

const QuestionDialog = lazy(() =>
  import('@/features/questions/QuestionDialog').then((module) => ({
    default: module.QuestionDialog,
  }))
);
const commentSchema = z.object({ text: z.string().trim().min(1).max(2000) });
/** Questions per load; the window grows by this many as the reader nears its end. */
const PAGE = 10;

/**
 * Question bank: every question of the chosen topic in the main panel; exams,
 * topics and the topic's question list in the right column (a floating bar
 * and bottom sheet on phones).
 */
export default function QuestionBank() {
  const { topicId = '', questionId = '' } = useParams({ strict: false }) as {
    topicId?: string;
    questionId?: string;
  };
  const navigate = useNavigate();
  const client = useQueryClient();
  const search = useSearch({ strict: false });
  const [showTopics, setShowTopics] = useState(!topicId);
  const [navOpen, setNavOpen] = useState(false);
  const [topicFilter, setTopicFilter] = useState('');
  const [filter, setFilter] = useState('');
  const [unreviewed, setUnreviewed] = useState(false);
  const [types, setTypes] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  // The marks the status filter was set against, so a question answered
  // while filtered stays in view.
  const [statusMarks, setStatusMarks] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [copying, setCopying] = useState(false);
  const [shownTopic, setShownTopic] = useState(topicId);
  if (shownTopic !== topicId) {
    setShownTopic(topicId);
    setFilter('');
    setTypes([]);
    setStatuses([]);
    setSelected([]);
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
  const {
    data: list,
    error: listError,
    isPending: listPending,
  } = useQuery({
    ...bankQuestionsQuery(topicId),
    meta: { errorBoundary: false },
  });
  // Learners' results lead the list rows in view mode only.
  const { data: results, error: resultsError } = useQuery({
    ...bankMarksQuery(topicId),
    enabled: Boolean(topicId) && mode === 'view',
    meta: { errorBoundary: false },
  });
  const marks = mode === 'view' && !resultsError ? results?.marks : undefined;
  const questions = list?.questions ?? [];
  const rows = filterBankRows(
    questions,
    types,
    marks ? statuses : [],
    statusMarks
  ).filter(
    (row) =>
      (mode !== 'edit' || !unreviewed || !row.reviewedAt) &&
      row.preview.toLowerCase().includes(filter.toLowerCase())
  );
  const filters: FilterSection[] = [
    {
      key: 'type',
      label: m.question_ui_question_type(),
      onToggle: (value) => setTypes(toggleValue(types, value)),
      options: QUESTION_TYPES.filter((type) =>
        questions.some((row) => row.answerTypes.includes(type))
      ).map((type) => ({ label: answerLabels[type](), value: type })),
      selected: types,
    },
  ];
  if (marks)
    filters.push({
      key: 'status',
      label: m.common_status(),
      onToggle: (value) => {
        setStatusMarks(marks);
        setStatuses(toggleValue(statuses, value));
      },
      options: BANK_STATUSES.map((status) => ({
        label: statusLabels[status](),
        value: status,
      })),
      selected: statuses,
    });
  function selectQuestion(id: string, checked: boolean) {
    if (!checked) setSelected(selected.filter((item) => item !== id));
    else if (selected.length < COPY_MAX) setSelected([...selected, id]);
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
      client.setQueryData(bankQuestionQuery(saved.question.id).queryKey, saved);
      void client.invalidateQueries({
        queryKey: bankQuestionsQuery(saved.topicId).queryKey,
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
      client.setQueryData(bankQuestionQuery(saved.question.id).queryKey, saved);
      void client.invalidateQueries({
        queryKey: bankQuestionsQuery(saved.topicId).queryKey,
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
      search: { mode: next === 'edit' ? ('edit' as const) : undefined },
    };
    if (topicId)
      void navigate({ ...options, params: { topicId }, to: '/bank/$topicId' });
    else void navigate({ ...options, to: '/bank' });
  }
  function topic(id: string) {
    setShowTopics(false);
    setNavOpen(false);
    void navigate({
      params: { topicId: id },
      search: modeSearch,
      to: '/bank/$topicId',
    });
  }
  /** From the landing: Continue opens the next question, Summary the top. */
  function openProgress(id: string, next: string | null) {
    setShowTopics(false);
    if (next)
      void navigate({
        params: { questionId: next, topicId: id },
        search: modeSearch,
        to: '/bank/$topicId/$questionId',
      });
    else {
      scrollRef.current?.scrollTo({ top: 0 });
      void navigate({
        params: { topicId: id },
        search: modeSearch,
        to: '/bank/$topicId',
      });
    }
  }
  function select(id: string) {
    setNavOpen(false);
    // The URL does not change for the current question, so scroll directly.
    if (id === questionId) scrollToQuestion(scrollRef.current, id);
    void navigate({
      params: { questionId: id, topicId },
      replace: true,
      search: modeSearch,
      to: '/bank/$topicId/$questionId',
    });
  }

  const place = syllabus?.exams
    .flatMap((exam) =>
      exam.subjects.flatMap((subject) =>
        subject.topics.map((item) => ({ exam, item, subject }))
      )
    )
    .find(({ item }) => item.id === topicId);

  const nav = syllabus ? (
    showTopics || !topicId ? (
      <TopicTree
        edit={mode === 'edit'}
        filter={topicFilter}
        onFilter={setTopicFilter}
        onTopic={topic}
        syllabus={syllabus}
        topicId={topicId}
      />
    ) : (
      <TopicQuestions
        edit={mode === 'edit'}
        filter={filter}
        filters={filters}
        label={place?.item.label ?? ''}
        list={list}
        onBack={() => setShowTopics(true)}
        onFilter={setFilter}
        onQuestion={select}
        onResetFilters={() => {
          setTypes([]);
          setStatuses([]);
        }}
        onUnreviewed={setUnreviewed}
        questionId={questionId}
        results={mode === 'view' && !resultsError ? (marks ?? {}) : undefined}
        rows={rows}
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
      <BankLanding nav={nav} onOpen={openProgress} view={mode === 'view'} />
    );
  else if (listError)
    body = (
      <BankError
        error={listError}
        onRetry={() =>
          void client.invalidateQueries({
            queryKey: bankQuestionsQuery(topicId).queryKey,
          })
        }
      />
    );
  else if (listPending) body = <Skeleton className="h-64 w-full" />;
  else if (rows.length)
    body = (
      <BankQuestions
        // A new topic or filter starts a new window.
        key={[
          topicId,
          filter,
          mode === 'edit' && unreviewed,
          types,
          marks && statuses,
        ].join('|')}
        mode={mode}
        onComment={setCommentFor}
        onEdit={(detail) => setEditing(structuredClone(detail))}
        onReview={(detail) =>
          setReviewed({
            id: detail.question.id,
            reviewed: !detail.reviewedAt,
          })
        }
        onSelect={selectQuestion}
        questionId={questionId}
        reviewing={reviewing}
        rows={rows}
        scrollRef={scrollRef}
        selected={selected}
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
          sectionClassName="h-full p-2.5"
        >
          {nav}
        </Panel>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Panel
          className="min-h-0 flex-1 rounded-button lg:rounded-card-xl"
          scrollRef={scrollRef}
          sectionClassName="h-full gap-0"
        >
          <QuizPageHeader
            actions={
              syllabus?.editor && (
                <Button
                  className="rounded-input"
                  iconLeft={mode === 'edit' ? 'view' : 'pencil'}
                  onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}
                  size="sm"
                >
                  {mode === 'edit'
                    ? m.question_ui_view_mode()
                    : m.question_ui_edit_mode()}
                </Button>
              )
            }
            meta={
              topicId &&
              list &&
              [
                list.questions.length === 1
                  ? m.question_ui_one_question()
                  : m.question_ui_question_count({
                      count: list.questions.length,
                    }),
                mode === 'edit' &&
                  m.question_ui_reviewed_count({
                    count: list.questions.filter((row) => row.reviewedAt)
                      .length,
                  }),
              ]
                .filter(Boolean)
                .join(' · ')
            }
            onBack={() =>
              void navigate({ search: { tab: 'blocks' }, to: '/files' })
            }
            title={place?.item.label ?? m.question_ui_question_bank()}
            topBar={false}
            trail={
              place
                ? [
                    m.question_ui_question_bank(),
                    place.exam.label,
                    place.subject.label,
                  ]
                : []
            }
          />
          <div
            className={cn(
              'px-4 pt-8 pb-28 sm:px-6 lg:px-10 lg:pb-10 xl:px-16',
              selected.length > 0 && 'lg:pb-28'
            )}
          >
            <div className="max-w-3xl">{body}</div>
          </div>
        </Panel>
        {/* Phones: the side panel becomes a floating bar and a bottom sheet,
            as in WorkspaceOpen's single-column layout. */}
        {topicId && syllabus && (
          <FloatingToolbar
            aria-label={m.question_ui_bank_navigation()}
            className="gap-1 rounded-full! px-2 py-1 lg:hidden"
            open={!navOpen && !selected.length}
            positionClassName="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 lg:hidden"
          >
            <ToolbarButton
              className="h-10 w-auto gap-2 rounded-card-xl px-3 [&_svg]:size-5"
              label={m.question_ui_topics()}
              onClick={() => {
                setShowTopics(true);
                setNavOpen(true);
              }}
              tooltipSide="top"
            >
              <Icon name="book" />
              <span>{m.question_ui_topics()}</span>
            </ToolbarButton>
            <ToolbarButton
              className="h-10 w-auto gap-2 rounded-card-xl px-3 [&_svg]:size-5"
              label={m.question_ui_questions()}
              onClick={() => {
                setShowTopics(false);
                setNavOpen(true);
              }}
              tooltipSide="top"
            >
              <Icon name="list" />
              <span>{m.question_ui_questions()}</span>
            </ToolbarButton>
          </FloatingToolbar>
        )}
        {/* Copy to quiz (mock 3.1 B): the count, Copy to quiz and clear. */}
        <FloatingToolbar
          aria-label={m.question_ui_copy_to_quiz()}
          className="gap-1 rounded-full! px-2 py-1"
          open={selected.length > 0 && !navOpen}
          positionClassName="absolute bottom-4 left-1/2 z-10 -translate-x-1/2"
        >
          <span className="whitespace-nowrap pr-1 pl-2 text-fg-muted text-sm">
            {m.question_ui_selected_count({ count: selected.length })}
          </span>
          <ToolbarButton
            className="h-10 w-auto gap-2 rounded-card-xl px-3 [&_svg]:size-5"
            label={m.question_ui_copy_to_quiz()}
            onClick={() => setCopying(true)}
            tooltipSide="top"
          >
            <Icon name="copy" />
            <span className="whitespace-nowrap">
              {m.question_ui_copy_to_quiz()}
            </span>
          </ToolbarButton>
          <ToolbarButton
            className="h-10 rounded-card-xl [&_svg]:size-5"
            label={m.question_ui_clear_selection()}
            onClick={() => setSelected([])}
            tooltipSide="top"
          >
            <Icon name="x" />
          </ToolbarButton>
        </FloatingToolbar>
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
          <div className="min-h-0 overflow-auto px-3 pb-6">{nav}</div>
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
                      ...bankQuestionQuery(editing.question.id),
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
                    queryKey: bankQuestionQuery(question.id).queryKey,
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
            setSelected([]);
          }}
          questionIds={questions
            .filter((row) => selected.includes(row.id))
            .map((row) => row.id)}
          topicLabel={place?.item.label ?? ''}
        />
      )}
    </div>
  );
}

const questionElement = (id: string) =>
  document.querySelector(`[data-question-id="${CSS.escape(id)}"]`);

/** Scrolls only the panel; scrollIntoView would also move the app shell when
 * the panel cannot scroll far enough. */
function scrollToQuestion(container: HTMLElement | null, id: string) {
  const element = questionElement(id);
  if (!container || !element) return;
  container.scrollTo({
    behavior: 'smooth',
    top:
      container.scrollTop +
      element.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      24,
  });
}

/**
 * The topic's questions as a window that loads PAGE at a time as the reader
 * nears its end. Jumping to a question outside the window (or not next to it)
 * restarts the window at the question's page, and a button above brings back
 * the earlier page while keeping the reading position: Safari has no scroll
 * anchoring, so content never loads above the viewport on its own.
 */
function BankQuestions({
  rows,
  questionId,
  topicId,
  mode,
  reviewing,
  selected,
  scrollRef,
  onReview,
  onComment,
  onEdit,
  onSelect,
}: {
  rows: BankRow[];
  questionId: string;
  topicId: string;
  mode: 'view' | 'edit';
  reviewing: boolean;
  /** Question ids ticked for Copy to quiz. */
  selected: string[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onReview: (detail: BankDetail) => void;
  onComment: (id: string) => void;
  onEdit: (detail: BankDetail) => void;
  onSelect: (id: string, checked: boolean) => void;
}) {
  const client = useQueryClient();
  const target = rows.findIndex((row) => row.id === questionId);
  const [range, setRange] = useState(() =>
    target >= 0 ? around(target) : { end: PAGE, start: 0 }
  );
  const shown = rows.slice(range.start, range.end);
  const { error, isFetching, refetch } = useQuery({
    ...bankBatchQuery(
      client,
      shown.map((row) => row.id)
    ),
    meta: { errorBoundary: false },
  });
  // Read-only views of the cache the batch fills.
  const details = useQueries({
    queries: shown.map((row) => ({
      ...bankQuestionQuery(row.id),
      enabled: false,
    })),
  });

  useEffect(() => {
    if (target >= 0) setRange((current) => jump(current, target));
  }, [target]);
  // Scroll once the question and everything above it in the window has loaded.
  const targetReady =
    target >= range.start &&
    target < range.end &&
    details.slice(0, target - range.start + 1).every((query) => query.data);
  useEffect(() => {
    if (targetReady) scrollToQuestion(scrollRef.current, questionId);
  }, [questionId, targetReady, scrollRef]);

  // Grow the window when its end comes within 800px of the viewport.
  const endRef = useRef<HTMLDivElement>(null);
  const [nearEnd, setNearEnd] = useState(false);
  useEffect(() => {
    const end = endRef.current;
    if (!end) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNearEnd(entry.isIntersecting),
      { root: scrollRef.current, rootMargin: '0px 0px 800px 0px' }
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [scrollRef]);
  const more = range.end < rows.length;
  useEffect(() => {
    if (nearEnd && more && !isFetching && !error)
      setRange((current) => ({ ...current, end: current.end + PAGE }));
  }, [nearEnd, more, isFetching, error]);

  // Earlier questions are fetched first, then inserted with the scroll
  // position moved by the height they add.
  const anchor = useRef<{ element: Element; top: number } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const earlier = Math.max(0, range.start - PAGE);
  async function showEarlier() {
    setLoadingEarlier(true);
    try {
      await client.fetchQuery(
        bankBatchQuery(
          client,
          rows.slice(earlier, range.start).map((row) => row.id)
        )
      );
      const first = rows[range.start];
      const element = first && questionElement(first.id);
      anchor.current = element && {
        element,
        top: element.getBoundingClientRect().top,
      };
      setRange((current) => ({ ...current, start: earlier }));
    } catch (loadError) {
      userToast({
        description: loadError instanceof Error ? loadError.message : undefined,
        title: m.question_ui_questions_load_failed(),
        variant: 'error',
      });
    } finally {
      setLoadingEarlier(false);
    }
  }
  useLayoutEffect(() => {
    const saved = anchor.current;
    anchor.current = null;
    if (saved && scrollRef.current)
      scrollRef.current.scrollTop +=
        saved.element.getBoundingClientRect().top - saved.top;
  }, [range.start, scrollRef]);

  return (
    <div className="grid gap-12">
      {range.start > 0 && (
        <Button
          className="rounded-input"
          disabled={loadingEarlier}
          fullWidth
          iconLeft="arrowUp"
          onClick={() => void showEarlier()}
          variant="outline"
        >
          {m.question_ui_show_questions({
            from: earlier + 1,
            to: range.start,
          })}
        </Button>
      )}
      <ol className="grid gap-12">
        {shown.map((row, i) => {
          const detail = details[i]?.data;
          return (
            <li
              className="relative grid gap-4 pl-6 sm:pl-0"
              data-question-id={row.id}
              key={row.id}
            >
              {detail ? (
                <>
                  {/* In the left margin, beside the question number. */}
                  <Checkbox
                    aria-label={m.question_ui_select_question({
                      number: row.position,
                    })}
                    checked={selected.includes(row.id)}
                    className="absolute top-1 left-0 sm:-left-6 lg:-left-7"
                    onChange={(checked) => onSelect(row.id, checked)}
                    size={16}
                  />
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
            void client.invalidateQueries({
              queryKey: bankQuestionsQuery(topicId).queryKey,
            });
            void refetch();
          }}
        />
      )}
      <div aria-hidden className="-mt-12" ref={endRef} />
    </div>
  );
}

/**
 * View mode: the learner answers, and Check answer reveals this question's
 * key, shows the quiz review and records the score; Try again starts over.
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
  const [checked, setChecked] = useState<ReturnType<typeof alignReveal> | null>(
    null
  );
  const { mutate: record } = useMutation({
    mutationFn: (score: number) => recordBankAnswer(question.id, { score }),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: bankMarksQuery(topicId).queryKey,
      });
      void client.invalidateQueries({ queryKey: bankProgressQuery().queryKey });
    },
  });
  const { mutate: check, isPending } = useMutation({
    mutationFn: (sent: Answers) =>
      revealBankQuestion(question.id, { answers: sent }),
    onSuccess: (revealed, sent) => {
      const next = alignReveal(question, revealed.question, sent);
      setChecked(next);
      // Open parts need Jev, so their questions show the key unscored.
      const score = bankScore(next.question, next.answers);
      if (score !== null) record(score);
    },
  });
  return (
    <>
      <QuestionRunner
        answers={checked?.answers ?? answers}
        disabled={Boolean(checked) || isPending}
        onChange={(partId, value) =>
          setAnswers((current) => ({ ...current, [partId]: value }))
        }
        question={checked?.question ?? question}
        questionNumber={questionNumber}
        review={Boolean(checked)}
      />
      <div className="flex justify-end border-divider border-t pt-3">
        {checked ? (
          <Button
            className="h-7 gap-1 rounded-input px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
            iconLeft="refresh"
            iconLeftClassName="size-3.5 sm:size-3.75"
            onClick={() => {
              setChecked(null);
              setAnswers({});
            }}
            size="sm"
            variant="ghost-hover"
          >
            {m.question_ui_answer_again()}
          </Button>
        ) : (
          <Button
            className="h-7 gap-1 rounded-input px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
            disabled={isPending}
            iconLeft="check"
            iconLeftClassName="size-3.5 sm:size-3.75"
            onClick={() => check(answers)}
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
  leading,
  filter,
  onFilter,
  searchLabel,
}: {
  title: string;
  leading?: ReactNode;
  filter: string;
  onFilter: (value: string) => void;
  searchLabel: string;
}) {
  const [searching, setSearching] = useState(filter !== '');
  return (
    <div className="flex h-10 items-center gap-1 pl-1">
      {searching ? (
        <Input
          actionCallback={() => {
            onFilter('');
            setSearching(false);
          }}
          actionIcon="x"
          actionLabel={m.question_ui_close_search()}
          aria-label={searchLabel}
          autoFocus
          leftIcon="search"
          onChange={(event) => onFilter(event.target.value)}
          placeholder={searchLabel}
          size="sm"
          value={filter}
          wrapperClassName="w-full"
        />
      ) : (
        <>
          {leading}
          <h2 className="t-subtitle mr-auto min-w-0 truncate pl-1">{title}</h2>
          <ToolbarButton label={searchLabel} onClick={() => setSearching(true)}>
            <Icon name="search" />
          </ToolbarButton>
        </>
      )}
    </div>
  );
}

/** Exams and topics in the FilesPanel rhythm: exam label, subject row, indented topics. */
function TopicTree({
  syllabus,
  topicId,
  edit,
  filter,
  onFilter,
  onTopic,
}: {
  syllabus: BankSyllabus;
  topicId: string;
  edit: boolean;
  filter: string;
  onFilter: (value: string) => void;
  onTopic: (id: string) => void;
}) {
  const needle = filter.trim().toLocaleLowerCase();
  const exams = syllabus.exams
    .map((exam) => ({
      ...exam,
      subjects: exam.subjects
        .map((subject) => ({
          ...subject,
          topics: subject.topics.filter((item) =>
            [exam.label, subject.label, item.label].some((label) =>
              label.toLocaleLowerCase().includes(needle)
            )
          ),
        }))
        .filter((subject) => subject.topics.length > 0),
    }))
    .filter((exam) => exam.subjects.length > 0);
  return (
    <nav aria-label={m.question_ui_topics()} className="flex flex-col gap-3">
      <PanelHeading
        filter={filter}
        onFilter={onFilter}
        searchLabel={m.question_ui_find_a_topic()}
        title={m.question_ui_exams_and_topics()}
      />
      {exams.map((exam) => (
        <div key={exam.id}>
          <div className="t-label px-2 py-1.5 text-fg-muted">{exam.label}</div>
          {exam.subjects.map((subject) => (
            <details className="group" key={subject.id} open>
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-button px-2 py-1.5 hover:bg-surface-hover-bg [&::-webkit-details-marker]:hidden">
                <Icon
                  className="shrink-0 -rotate-90 text-fg-muted transition-transform group-open:rotate-0"
                  name="chevronDown"
                  size={13}
                />
                <span className="translate-y-px truncate font-semibold">
                  {subject.label}
                </span>
              </summary>
              <ul className="flex flex-col pl-5">
                {subject.topics.map((item) => (
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
                      <span className="shrink-0 font-semibold text-fg-muted text-xs tabular-nums">
                        {edit ? `${item.reviewed}/${item.total}` : item.total}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      ))}
      {!exams.length && (
        <p className="px-2 text-fg-muted">
          {syllabus.exams.length
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
  list,
  rows,
  questionId,
  edit,
  filter,
  filters,
  unreviewed,
  results,
  onBack,
  onFilter,
  onResetFilters,
  onUnreviewed,
  onQuestion,
}: {
  label: string;
  list?: { questions: BankRow[] };
  rows: BankRow[];
  questionId: string;
  edit: boolean;
  filter: string;
  filters: FilterSection[];
  unreviewed: boolean;
  /** View mode: answered questions' latest scores by id. */
  results?: Record<string, number>;
  onBack: () => void;
  onFilter: (value: string) => void;
  onResetFilters: () => void;
  onUnreviewed: (value: boolean) => void;
  onQuestion: (id: string) => void;
}) {
  const scores = Object.values(results ?? {});
  return (
    <nav aria-label={m.question_ui_questions()} className="flex flex-col gap-3">
      <PanelHeading
        filter={filter}
        leading={
          <ToolbarButton
            label={m.question_ui_back_to_topics()}
            onClick={onBack}
          >
            <Icon name="navigationBack" />
          </ToolbarButton>
        }
        onFilter={onFilter}
        searchLabel={m.question_ui_find_a_question()}
        title={label}
      />
      <div className="flex flex-wrap items-center gap-1 px-1">
        {edit && (
          <>
            <Button
              aria-pressed={!unreviewed}
              className="rounded-input"
              onClick={() => onUnreviewed(false)}
              size="sm"
              variant={unreviewed ? 'ghost-hover' : 'gray'}
            >
              {m.action_all()} {list?.questions.length ?? 0}
            </Button>
            <Button
              aria-pressed={unreviewed}
              className="rounded-input"
              onClick={() => onUnreviewed(true)}
              size="sm"
              variant={unreviewed ? 'gray' : 'ghost-hover'}
            >
              {m.question_ui_unreviewed()}{' '}
              {list?.questions.filter((row) => !row.reviewedAt).length ?? 0}
            </Button>
          </>
        )}
        <FilterPopover filters={filters} onResetFilters={onResetFilters} />
      </div>
      {results && (
        <p className="t-meta px-2 text-fg-muted">
          {m.question_ui_correct_and_retry({
            correct: scores.filter((score) => score >= 1).length,
            retry: scores.filter((score) => score < 1).length,
          })}
        </p>
      )}
      <ol className="grid gap-0.5">
        {rows.map((row) => (
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
              onClick={() => onQuestion(row.id)}
              result={results && (results[row.id] ?? null)}
              row={row}
            />
          </li>
        ))}
      </ol>
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
          className="h-7 gap-1 rounded-input px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
          disabled={reviewing}
          iconLeft={detail.reviewedAt ? 'x' : 'check'}
          iconLeftClassName="size-3.5 sm:size-3.75"
          onClick={onReview}
          size="sm"
          variant={detail.reviewedAt ? 'danger-light' : 'ghost-hover'}
        >
          {detail.reviewedAt
            ? m.question_ui_undo_review()
            : m.question_ui_mark_reviewed()}
        </Button>
        <Button
          className="h-7 gap-1 rounded-input px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
          iconLeft="comment"
          iconLeftClassName="size-3.5 sm:size-3.75"
          onClick={onComment}
          size="sm"
          variant="ghost-hover"
        >
          {m.question_ui_comment()}
        </Button>
        <Button
          aria-label={m.question_ui_edit_question()}
          className="h-7 gap-1 rounded-input px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
          iconLeft="pencil"
          iconLeftClassName="size-3.5 sm:size-3.75"
          onClick={onEdit}
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
 * /bank with no topic open: in View mode, the topics the learner has answered
 * in, in the Learning Review tab's table, each with Continue (the next
 * unanswered question) or, once all are answered, Summary (the topic's top).
 * Without any, Choose a topic as before; phones pick topics in the page.
 */
function BankLanding({
  view,
  nav,
  onOpen,
}: {
  view: boolean;
  nav: ReactNode;
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
  else if (view && data?.topics.length)
    progress = <ProgressTable onOpen={onOpen} topics={data.topics} />;
  return (
    <div className="grid gap-8">
      {progress}
      <div className="lg:hidden">{nav}</div>
      {!progress && (
        <p className="hidden text-fg-muted lg:block">
          {m.question_ui_choose_a_topic()}
        </p>
      )}
    </div>
  );
}

function ProgressTable({
  topics,
  onOpen,
}: {
  topics: BankTopicProgress[];
  onOpen: (topicId: string, next: string | null) => void;
}) {
  return (
    <div className="overflow-hidden rounded-card border border-line">
      <div className="grid grid-cols-[minmax(0,1fr)_5rem_6rem] items-center gap-3 bg-surface-hover-bg px-4 py-3 font-bold text-fg-muted text-xs uppercase tracking-wide md:grid-cols-[minmax(0,1fr)_7rem_6rem_6rem]">
        <div>{m.question_ui_col_topic()}</div>
        <div className="text-center">{m.question_ui_col_answered()}</div>
        <div className="hidden text-center md:block">
          {m.question_ui_status_correct()}
        </div>
        <div />
      </div>
      {topics.map((topic) => (
        <div
          className="grid grid-cols-[minmax(0,1fr)_5rem_6rem] items-center gap-3 border-divider border-t py-2 pr-2 pl-4 first:border-t-0 md:grid-cols-[minmax(0,1fr)_7rem_6rem_6rem]"
          key={topic.topicId}
        >
          <div className="min-w-0">
            <div className="truncate font-semibold text-fg">
              {topic.topicLabel}
            </div>
            <div className="truncate text-fg-muted text-xs">
              {topic.examLabel} · {topic.subjectLabel}
            </div>
          </div>
          <div className="text-center tabular-nums">
            {m.study_of({ done: topic.answered, total: topic.total })}
          </div>
          <div className="hidden text-center text-fg-muted text-sm tabular-nums md:block">
            {topic.correct}
          </div>
          <Button
            onClick={() => onOpen(topic.topicId, topic.nextQuestionId)}
            size="sm"
            variant="outline"
          >
            {topic.nextQuestionId
              ? m.question_ui_continue()
              : m.question_ui_summary()}
          </Button>
        </div>
      ))}
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
          className="rounded-input"
          disabled={isPending}
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
        maxLength={2000}
      />
      <InputError>{errors.text?.message}</InputError>
    </SimpleDialog>
  );
}
