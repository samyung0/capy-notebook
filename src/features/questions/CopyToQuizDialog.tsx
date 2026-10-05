import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { qk } from '@/api/client';
import { copyBankQuestionsBodyQuizNameMax } from '@/api/gen/validators';
import { useChapters, useMaterials, useWorkspaces } from '@/api/hooks';
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
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { copyBankQuestions } from './bank';

/** Radix Select items cannot use an empty value. */
const NO_CHAPTER = 'none';
const nameSchema = z.object({
  quizName: z.string().trim().min(1).max(copyBankQuestionsBodyQuizNameMax),
});
const rowClass =
  'flex h-9 w-full items-center gap-2.5 rounded-button px-2.5 py-2 text-left transition-colors hover:bg-surface-hover-bg';

/**
 * Copy to quiz (mock 3.2 B): Workspace and Chapter dropdowns, then the
 * chapter's quizzes as rows under New quiz, which turns into a name field.
 * Only workspaces the learner can edit are offered.
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
  // Empty picks follow the defaults: the first workspace and chapter, and a
  // new quiz.
  const [picked, setPicked] = useState({
    chapterId: '',
    quizId: '',
    workspaceId: '',
  });
  const workspaceId = picked.workspaceId || editable[0]?.id || '';
  const { data: chapters } = useChapters(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const chapterId = picked.chapterId || chapters?.[0]?.id || NO_CHAPTER;
  const quizzes = (materials ?? []).filter(
    (item) =>
      item.type === 'quiz' && (item.chapterId ?? NO_CHAPTER) === chapterId
  );
  const quizId = quizzes.some((quiz) => quiz.id === picked.quizId)
    ? picked.quizId
    : '';
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
    target: Pick<BankCopyReq, 'chapterId' | 'quizId' | 'quizName'>
  ) {
    try {
      const copied = await copy({ questionIds, workspaceId, ...target });
      void client.invalidateQueries({
        queryKey: qk.materials(copied.workspaceId),
      });
      void client.invalidateQueries({ queryKey: qk.quiz(copied.quizId) });
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
          className="rounded-input"
          disabled={isPending || !workspaceId}
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
            submit({
              chapterId: chapterId === NO_CHAPTER ? undefined : chapterId,
              quizName,
            })
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
              onValueChange={(id) =>
                setPicked({ chapterId: '', quizId: '', workspaceId: id })
              }
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
                    {ws.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow title={m.question_ui_chapter()}>
            <Select
              onValueChange={(id) =>
                setPicked({ ...picked, chapterId: id, quizId: '' })
              }
              value={chapterId}
            >
              <SelectTrigger
                aria-label={m.question_ui_chapter()}
                className="sm:w-56"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {chapters?.map((chapter) => (
                  <SelectItem key={chapter.id} value={chapter.id}>
                    {chapter.name}
                  </SelectItem>
                ))}
                <SelectItem value={NO_CHAPTER}>
                  {m.question_ui_no_chapter()}
                </SelectItem>
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
                  <Input
                    aria-label={m.question_ui_quiz_name()}
                    leftIcon="plus"
                    {...register('quizName')}
                  />
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
                    <Icon className="size-3.75 shrink-0" name="quiz" />
                    <span
                      className={cn('flex-1 truncate', active && 'font-bold')}
                    >
                      {quiz.title}
                    </span>
                    {active && (
                      <Icon className="size-3.75 shrink-0" name="check" />
                    )}
                  </button>
                );
              })}
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
