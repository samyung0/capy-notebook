import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, isApiError } from '@/api/client';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input, InputError } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/TextArea';
import { Toolbar, ToolbarGroup } from '@/components/ui/Toolbar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { MaterialModeToggle } from '@/features/materials/MaterialModeToggle';
import {
  type BankDetail,
  type BankRow,
  bankQuestionQuery,
  bankQuestionsQuery,
  bankSyllabusQuery,
  uploadBankAsset,
} from '@/features/questions/bank';
import { QuestionView, TextView } from '@/features/questions/QuestionView';
import type { Question } from '@/features/questions/types';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';

const QuestionDialog = lazy(() =>
  import('@/features/questions/QuestionDialog').then((module) => ({
    default: module.QuestionDialog,
  }))
);
const commentSchema = z.object({ text: z.string().trim().min(1).max(2000) });
export default function QuestionBank() {
  const { topicId = '', questionId = '' } = useParams({ strict: false }) as {
    topicId?: string;
    questionId?: string;
  };
  const navigate = useNavigate();
  const client = useQueryClient();
  const search = useSearch({ strict: false });
  function setMode(next: 'view' | 'edit') {
    const options = {
      replace: true,
      search: { mode: next === 'edit' ? ('edit' as const) : undefined },
    };
    if (questionId)
      void navigate({
        ...options,
        params: { questionId, topicId },
        to: '/bank/$topicId/$questionId',
      });
    else if (topicId)
      void navigate({ ...options, params: { topicId }, to: '/bank/$topicId' });
    else void navigate({ ...options, to: '/bank' });
  }
  const [showTopics, setShowTopics] = useState(false);
  const [topicFilter, setTopicFilter] = useState('');
  const [filter, setFilter] = useState('');
  const [unreviewed, setUnreviewed] = useState(false);
  const [editing, setEditing] = useState<BankDetail | null>(null);
  const [conflict, setConflict] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
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
  const {
    data: detail,
    error: detailError,
    isPending: detailPending,
  } = useQuery({
    ...bankQuestionQuery(questionId),
    meta: { errorBoundary: false },
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
  function topic(id: string) {
    setShowTopics(false);
    setFilter('');
    void navigate({
      params: { topicId: id },
      search: { mode: search.mode === 'edit' ? 'edit' : undefined },
      to: '/bank/$topicId',
    });
  }
  function select(id: string) {
    setShowTopics(false);
    void navigate({
      params: { questionId: id, topicId },
      search: { mode: search.mode === 'edit' ? 'edit' : undefined },
      to: '/bank/$topicId/$questionId',
    });
  }
  const rows = (list?.questions ?? []).filter(
    (row) =>
      (mode !== 'edit' || !unreviewed || !row.reviewedAt) &&
      row.preview.toLowerCase().includes(filter.toLowerCase())
  );
  const selectedTopic = syllabus?.exams
    .flatMap((exam) => exam.subjects.flatMap((subject) => subject.topics))
    .find((item) => item.id === topicId);
  const selectedIndex = rows.findIndex((row) => row.id === questionId);
  const topicSearch = topicFilter.trim().toLocaleLowerCase();
  const exams = (syllabus?.exams ?? [])
    .map((exam) => ({
      ...exam,
      subjects: exam.subjects
        .map((subject) => ({
          ...subject,
          topics: subject.topics.filter((item) =>
            [exam.label, subject.label, item.label].some((label) =>
              label.toLocaleLowerCase().includes(topicSearch)
            )
          ),
        }))
        .filter((subject) => subject.topics.length > 0),
    }))
    .filter((exam) => exam.subjects.length > 0);
  return (
    <PanelWithInvertedRadius>
      <PageHeader
        actions={
          syllabus?.editor && (
            <MaterialModeToggle mode={mode} onChange={setMode} />
          )
        }
        className="shrink-0 flex-wrap gap-3 px-4 sm:px-6 lg:gap-6"
        title={
          <div className="flex items-center gap-3 whitespace-nowrap">
            <Link aria-label={m.action_back()} to="/create">
              <Icon name="navigationBack" size={20} />
            </Link>
            <h1 className="t-subtitle">{m.question_ui_question_bank()}</h1>
          </div>
        }
        titleClassName="shrink-0"
      />
      {fetchStatus === 'paused' ? (
        <QueryPausedState />
      ) : syllabusPending ? (
        <p className="p-6" role="status">
          {m.question_ui_loading_question_bank()}
        </p>
      ) : syllabusError ? (
        <BankError
          error={syllabusError}
          onRetry={() =>
            void client.invalidateQueries({
              queryKey: bankSyllabusQuery().queryKey,
            })
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside
            aria-label={m.question_ui_topics()}
            className={cn(
              'w-full shrink-0 overflow-auto border-divider px-4 py-5 md:w-72 md:border-r xl:block',
              !topicId || showTopics ? 'block' : 'hidden'
            )}
          >
            <Input
              aria-label={m.question_ui_find_a_topic()}
              onChange={(event) => setTopicFilter(event.target.value)}
              placeholder={m.question_ui_find_a_topic()}
              value={topicFilter}
              wrapperClassName="mb-5"
            />
            {exams.map((exam) => (
              <div className="mb-6" key={exam.id}>
                <h2 className="t-subtitle mb-3">{exam.label}</h2>
                {exam.subjects.map((subject) => (
                  <details className="mb-3" key={subject.id} open>
                    <summary className="cursor-pointer font-medium">
                      {subject.label}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {subject.topics.map((item) => (
                        <li key={item.id}>
                          <button
                            aria-current={
                              item.id === topicId ? 'page' : undefined
                            }
                            className={cn(
                              'flex w-full items-start justify-between gap-3 rounded-input px-3 py-2 text-left text-sm hover:bg-surface-hover-bg',
                              item.id === topicId && 'bg-tint-accent-1'
                            )}
                            onClick={() => topic(item.id)}
                            type="button"
                          >
                            <span>{item.label}</span>
                            <span className="shrink-0 text-fg-muted">
                              {mode === 'edit' ? item.reviewed + '/' : ''}
                              {item.total}
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
              <p className="text-fg-muted">
                {syllabus?.exams.length
                  ? m.question_ui_no_topics_match()
                  : m.question_ui_no_syllabi_have_been_published_yet()}
              </p>
            )}
          </aside>
          <section
            aria-label={m.question_ui_questions()}
            className={cn(
              'flex w-full shrink-0 flex-col border-divider md:w-80 md:border-r xl:w-88',
              !topicId || showTopics
                ? 'hidden xl:flex'
                : questionId
                  ? 'hidden md:flex'
                  : 'flex'
            )}
          >
            <div className="space-y-3 border-divider border-b p-4">
              <Button
                className="xl:hidden"
                iconLeft="navigationBack"
                onClick={() => setShowTopics(true)}
                size="sm"
                variant="ghost"
              >
                {m.question_ui_topics()}
              </Button>
              <h2 className="font-semibold">
                {selectedTopic?.label ?? m.question_ui_choose_a_topic()}
              </h2>
              {topicId && (
                <Input
                  aria-label={m.question_ui_find_a_question()}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={m.question_ui_find_a_question()}
                  value={filter}
                />
              )}
              {mode === 'edit' && (
                <div className="flex gap-1">
                  <Button
                    aria-pressed={!unreviewed}
                    onClick={() => setUnreviewed(false)}
                    size="sm"
                    variant={unreviewed ? 'ghost' : 'gray'}
                  >
                    {m.action_all()} {list?.questions.length ?? 0}
                  </Button>
                  <Button
                    aria-pressed={unreviewed}
                    onClick={() => setUnreviewed(true)}
                    size="sm"
                    variant={unreviewed ? 'gray' : 'ghost'}
                  >
                    {m.question_ui_unreviewed()}{' '}
                    {list?.questions.filter((row) => !row.reviewedAt).length ??
                      0}
                  </Button>
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {topicId &&
                (listError ? (
                  <BankError
                    error={listError}
                    onRetry={() =>
                      void client.invalidateQueries({
                        queryKey: bankQuestionsQuery(topicId).queryKey,
                      })
                    }
                  />
                ) : listPending ? (
                  <p className="p-4">{m.question_ui_loading_questions()}</p>
                ) : rows.length ? (
                  rows.map((row) => (
                    <QuestionRow
                      edit={mode === 'edit'}
                      key={row.id}
                      onClick={() => select(row.id)}
                      row={row}
                      selected={row.id === questionId}
                    />
                  ))
                ) : (
                  <p className="p-4 text-fg-muted">
                    {m.question_ui_no_questions_match()}
                  </p>
                ))}
            </div>
          </section>
          <section
            aria-label={m.question_ui_question()}
            className={cn(
              'min-w-0 flex-1 flex-col',
              questionId && !showTopics ? 'flex' : 'hidden md:flex'
            )}
          >
            {questionId ? (
              detailError ? (
                <BankError
                  error={detailError}
                  onRetry={() =>
                    void client.invalidateQueries({
                      queryKey: bankQuestionQuery(questionId).queryKey,
                    })
                  }
                />
              ) : detailPending ? (
                <p className="p-6">{m.question_ui_loading_question()}</p>
              ) : (
                detail && (
                  <>
                    <Toolbar className="scroll-fade-x min-w-0 gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      <ToolbarGroup className="md:hidden">
                        <ToolbarButton
                          label={m.question_ui_questions()}
                          onClick={() => topic(topicId)}
                        >
                          <Icon name="navigationBack" />
                        </ToolbarButton>
                      </ToolbarGroup>
                      <ToolbarGroup>
                        <ToolbarButton
                          disabled={selectedIndex <= 0}
                          label={m.question_ui_previous_question()}
                          onClick={() => select(rows[selectedIndex - 1].id)}
                        >
                          <Icon name="navigationBack" />
                        </ToolbarButton>
                        <ToolbarButton
                          disabled={
                            selectedIndex < 0 ||
                            selectedIndex >= rows.length - 1
                          }
                          label={m.question_ui_next_question()}
                          onClick={() => select(rows[selectedIndex + 1].id)}
                        >
                          <Icon name="navigationForward" />
                        </ToolbarButton>
                      </ToolbarGroup>
                      <span className="flex-1" />
                      {mode === 'edit' && detail.editor && (
                        <ToolbarGroup>
                          <ToolbarButton
                            label={m.question_ui_edit_question()}
                            onClick={() => setEditing(structuredClone(detail))}
                          >
                            <Icon name="pencil" />
                          </ToolbarButton>
                          <ToolbarButton
                            active={Boolean(detail.reviewedAt)}
                            disabled={reviewing}
                            label={
                              detail.reviewedAt
                                ? m.question_ui_mark_unreviewed()
                                : m.question_ui_mark_reviewed()
                            }
                            onClick={() =>
                              setReviewed({
                                id: detail.question.id,
                                reviewed: !detail.reviewedAt,
                              })
                            }
                          >
                            <Icon name="check" />
                          </ToolbarButton>
                        </ToolbarGroup>
                      )}
                      {mode === 'edit' && detail.editor && (
                        <ToolbarGroup>
                          <ToolbarButton
                            label={m.question_ui_comment()}
                            onClick={() => setCommentOpen(true)}
                          >
                            <Icon name="comment" />
                          </ToolbarButton>
                        </ToolbarGroup>
                      )}
                    </Toolbar>
                    <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6 xl:p-8">
                      <div className="mx-auto max-w-4xl">
                        <QuestionView
                          question={detail.question}
                          questionNumber={detail.position}
                          review={mode === 'edit' && detail.editor}
                        />
                        {mode === 'edit' && detail.reviewedAt && (
                          <p className="mt-6 text-fg-muted text-sm">
                            {detail.reviewerName
                              ? m.question_ui_reviewed_by({
                                  name: detail.reviewerName,
                                })
                              : m.question_ui_reviewed()}
                            {' · '}
                            <time dateTime={detail.reviewedAt}>
                              {new Date(detail.reviewedAt).toLocaleDateString(
                                getLocale()
                              )}
                            </time>
                          </p>
                        )}
                        <MaterialAttributionFooter
                          provenance={detail.provenance}
                        />
                      </div>
                    </div>
                  </>
                )
              )
            ) : (
              <p className="m-auto p-6 text-fg-muted">
                {m.question_ui_choose_a_question()}
              </p>
            )}
          </section>
        </div>
      )}
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
                  throw new Error(m.question_ui_conflict_message(), {
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
      {commentOpen && (
        <BankComment id={questionId} onClose={() => setCommentOpen(false)} />
      )}
    </PanelWithInvertedRadius>
  );
}
function QuestionRow({
  row,
  selected,
  edit,
  onClick,
}: {
  row: BankRow;
  selected: boolean;
  edit: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'flex w-full gap-3 border-divider border-b p-4 text-left hover:bg-surface-hover-bg',
        selected && 'bg-tint-accent-1'
      )}
      onClick={onClick}
      type="button"
    >
      <span className="text-fg-muted">{row.position}.</span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-3 text-sm">
          {row.preview ? (
            <TextView text={row.preview} />
          ) : (
            m.question_ui_question_number({ number: row.position })
          )}
        </span>
        <span className="mt-2 flex items-center gap-2 text-fg-muted text-xs">
          {row.marks === 1
            ? m.question_ui_one_mark()
            : m.question_ui_marks({ count: row.marks })}
          {row.hasFigure && <Icon name="image" size={13} />}
          {row.hasTable && <Icon name="table" size={13} />}
          {edit && row.reviewedAt && <Icon name="check" size={13} />}
        </span>
        {edit && row.reviewedAt && (
          <span className="mt-1 block text-fg-muted text-xs">
            {row.reviewerName
              ? m.question_ui_reviewed_by({ name: row.reviewerName })
              : m.question_ui_reviewed()}
            {' · '}
            <time dateTime={row.reviewedAt}>
              {relativeTime(row.reviewedAt)}
            </time>
          </span>
        )}
      </span>
    </button>
  );
}
function BankError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="space-y-3 p-6" role="alert">
      <p>{error.message}</p>
      <Button onClick={onRetry} variant="ghost">
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
  const { mutateAsync, isPending, error } = useMutation({
    mutationFn: (body: z.infer<typeof commentSchema>) =>
      api.post<void>(
        '/bank/questions/' + encodeURIComponent(id) + '/comments',
        body
      ),
  });
  return (
    <SimpleDialog
      footer={
        <Button disabled={isPending} type="submit">
          {m.question_ui_send_comment()}
        </Button>
      }
      onClose={onClose}
      onSubmit={handleSubmit(async (body) => {
        try {
          await mutateAsync(body);
          onClose();
        } catch {
          // Keep the comment and the mutation's error visible for a manual retry.
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
      <InputError>{errors.text?.message ?? error?.message}</InputError>
    </SimpleDialog>
  );
}
