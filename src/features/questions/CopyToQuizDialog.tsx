import { zodResolver } from '@hookform/resolvers/zod';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { qk } from '@/api/client';
import { copyBankQuestionsBodyQuizNameMax } from '@/api/gen/validators';
import { ownedMaterialsQuery, useChapters, useWorkspaces } from '@/api/hooks';
import type { BankCopyReq } from '@/api/types';
import { SettingRow } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { userToast } from '@/components/ui/userToast';
import {
  ChapterSelect,
  chapterByName,
  NewChapterInput,
} from '@/features/workspace/ChapterSelect';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import { copyBankQuestions } from './bank';

const nameSchema = z.object({
  quizName: z.string().trim().min(1).max(copyBankQuestionsBodyQuizNameMax),
});
const rowClass =
  'flex h-9 w-full items-center gap-2.5 rounded-button px-2.5 py-2 text-left transition-colors hover:bg-surface-hover-bg';

/**
 * Copy to quiz (mock 3.2 B): a Workspace dropdown, then every quiz in it as
 * rows under New quiz, which turns into a name field with its chapter picker
 * (an existing chapter, none, or a new one created with the copy). Only
 * workspaces the learner can edit are offered.
 */
export function CopyToQuizDialog({
  questionIds,
  topicLabel,
  onClose,
  onCopied,
}: {
  questionIds: string[];
  topicLabel: string;
  onClose: () => void;
  onCopied: () => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { data: workspaces, isPending: workspacesPending } = useWorkspaces();
  const editable = (workspaces ?? []).filter((ws) => ws.capabilities.canEdit);
  // Empty picks follow the defaults: the first workspace, a new quiz and no
  // chapter. chapterName is a typed chapter the server creates.
  const [picked, setPicked] = useState<{
    chapterId: string | null;
    chapterName: string | null;
    quizId: string;
    workspaceId: string;
  }>({ chapterId: null, chapterName: null, quizId: '', workspaceId: '' });
  const [newChapter, setNewChapter] = useState<string | null>(null);
  const workspaceId = picked.workspaceId || editable[0]?.id || '';
  const { data: chapters } = useChapters(workspaceId);
  // The Create page's list carries each quiz's chapter name and question count.
  const {
    data: quizPages,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    ...ownedMaterialsQuery({
      kinds: ['quiz'],
      locations: ['workspace'],
      scope: 'member',
      workspaceIds: [workspaceId],
    }),
    enabled: !!workspaceId,
  });
  const quizzes = quizPages?.pages.flatMap((page) => page.items) ?? [];
  const quizId = quizzes.some((quiz) => quiz.id === picked.quizId)
    ? picked.quizId
    : '';

  /** A name still being typed counts, so Copy never drops it. */
  function newQuizChapter() {
    const typed = newChapter?.trim();
    const chapter = typed ? chapterByName(chapters, typed) : picked;
    return {
      chapterId: chapter.chapterId ?? undefined,
      chapterName: chapter.chapterName ?? undefined,
    };
  }

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof nameSchema>>({
    defaultValues: { quizName: topicLabel },
    resolver: zodResolver(nameSchema),
  });
  const { mutateAsync: copy, isPending } = useMutation({
    mutationFn: copyBankQuestions,
  });

  async function submit(
    target: Pick<
      BankCopyReq,
      'chapterId' | 'chapterName' | 'quizId' | 'quizName'
    >
  ) {
    try {
      const copied = await copy({ questionIds, workspaceId, ...target });
      for (const queryKey of [
        qk.materials(copied.workspaceId),
        qk.quiz(copied.quizId),
        qk.ownedMaterialsRoot,
        ...(target.chapterName ? [qk.chapters(copied.workspaceId)] : []),
      ])
        void client.invalidateQueries({ queryKey });
      userToast({
        button: {
          label: m.question_ui_open_quiz(),
          onClick: () =>
            void navigate({
              params: { workspaceId: copied.workspaceId },
              search: { material: copied.quizId },
              to: '/workspaces/$workspaceId',
            }),
        },
        title: m.question_ui_copied(),
        variant: 'success',
      });
      onCopied();
    } catch {
      // The global mutation toast reports it; the dialog stays for a retry.
    }
  }

  return (
    <SimpleDialog
      footer={
        <Button
          disabled={isPending || !workspaceId}
          rounded="large"
          size="lg"
          type="submit"
          variant="accent"
        >
          {m.action_copy()}
        </Button>
      }
      onClose={onClose}
      onSubmit={(event) => {
        if (!quizId)
          return handleSubmit(({ quizName }) =>
            submit({ ...newQuizChapter(), quizName })
          )(event);
        event.preventDefault();
        void submit({ quizId });
      }}
      open
      title={
        questionIds.length === 1
          ? m.question_ui_copy_one_title()
          : m.question_ui_copy_title({ count: questionIds.length })
      }
      width={560}
    >
      {workspacesPending ? (
        <SkeletonList count={3} rowHeight={36} />
      ) : editable.length ? (
        <div className="flex flex-col gap-4">
          <SettingRow title={m.question_ui_workspace()}>
            <Select
              onValueChange={(id) => {
                setPicked({
                  chapterId: null,
                  chapterName: null,
                  quizId: '',
                  workspaceId: id,
                });
                setNewChapter(null);
              }}
              value={workspaceId}
            >
              <SelectTrigger
                aria-label={m.question_ui_workspace()}
                className="sm:w-56"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {editable.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>
                    <span className="flex min-w-0 items-center gap-2">
                      <img
                        alt=""
                        className="size-5 shrink-0 -translate-y-px rounded-md"
                        src={iconUrl(ws.iconId)}
                      />
                      <span className="truncate">{ws.name}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <div className="flex flex-col gap-2">
            <InputTitle>{m.question_ui_quiz()}</InputTitle>
            <div className="flex max-h-[40vh] flex-col gap-0.5 overflow-auto">
              {quizId ? (
                <button
                  className={rowClass}
                  onClick={() => setPicked({ ...picked, quizId: '' })}
                  type="button"
                >
                  <Icon className="size-3.75 shrink-0" name="plus" />
                  <span className="flex-1 truncate">
                    {m.question_ui_new_quiz()}
                  </span>
                </button>
              ) : (
                <div className="pb-1">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <Input
                        aria-label={m.question_ui_quiz_name()}
                        leftIcon="plus"
                        {...register('quizName')}
                      />
                    </div>
                    {newChapter === null ? (
                      <ChapterSelect
                        chapterName={picked.chapterName}
                        chapters={chapters ?? []}
                        onChange={(chapterId) =>
                          setPicked({ ...picked, chapterId, chapterName: null })
                        }
                        onCreateRequest={() => setNewChapter('')}
                        value={picked.chapterId}
                      />
                    ) : (
                      <NewChapterInput
                        onCancel={() => setNewChapter(null)}
                        onChange={setNewChapter}
                        onConfirm={() => {
                          const name = newChapter.trim();
                          if (!name) return;
                          setPicked({
                            ...picked,
                            ...chapterByName(chapters, name),
                          });
                          setNewChapter(null);
                        }}
                        value={newChapter}
                      />
                    )}
                  </div>
                  <InputError>{errors.quizName?.message}</InputError>
                </div>
              )}
              {quizzes.map((quiz) => {
                const active = quiz.id === quizId;
                return (
                  <button
                    aria-pressed={active}
                    className={cn(rowClass, active && 'bg-surface-dark')}
                    key={quiz.id}
                    onClick={() => setPicked({ ...picked, quizId: quiz.id })}
                    type="button"
                  >
                    <span
                      className={cn('min-w-0 truncate', active && 'font-bold')}
                    >
                      {quiz.title}
                    </span>
                    {quiz.chapterName && (
                      <span className="t-meta max-w-40 shrink-0 truncate text-fg-muted">
                        {quiz.chapterName}
                      </span>
                    )}
                    <span className="t-meta ml-auto shrink-0 text-fg-muted">
                      {quiz.questionCount === 1
                        ? m.question_ui_one_question()
                        : m.question_ui_question_count({
                            count: quiz.questionCount ?? 0,
                          })}
                    </span>
                    {active && (
                      <Icon className="size-3.75 shrink-0" name="check" />
                    )}
                  </button>
                );
              })}
              {hasNextPage && (
                <Button
                  className="self-center"
                  disabled={isFetchingNextPage}
                  onClick={() => fetchNextPage()}
                  size="sm"
                  variant="ghost-hover"
                >
                  {m.list_load_more()}
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-fg-muted">
          {m.question_ui_no_editable_workspaces()}
        </p>
      )}
    </SimpleDialog>
  );
}
