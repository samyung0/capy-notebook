import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { qk } from '@/api/client';
import { copyBankQuestionsBodyQuizNameMax } from '@/api/gen/validators';
import { useChapters, useWorkspaces } from '@/api/hooks';
import type { BankCopyReq } from '@/api/types';
import { SettingRow } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { InputError, InputTitle } from '@/components/ui/Input';
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
import { textLength } from '@/lib/textLength';
import { copyBankQuestions } from './bank';
import { type QuizTarget, QuizTargetSelect } from './QuizTargetSelect';

const nameSchema = z.object({
  quizName: z.string().trim().min(1).max(copyBankQuestionsBodyQuizNameMax),
});

/**
 * Copy to quiz: a Workspace dropdown, then one quiz picked or named in
 * QuizTargetSelect. Its Chapter row keeps its space while hidden: an existing
 * quiz shows its chapter locked, a new one takes an existing chapter, none,
 * or a new one created with the copy. Only workspaces the learner can edit
 * are offered.
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
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState('');
  const workspaceId = pickedWorkspaceId || editable[0]?.id || '';
  // The topic names a new quiz until the learner picks or types another.
  const [target, setTarget] = useState<QuizTarget | null>({
    kind: 'new',
    name: topicLabel,
  });
  // A new quiz's chapter; chapterName is a typed chapter the server creates.
  const [picked, setPicked] = useState<{
    chapterId: string | null;
    chapterName: string | null;
  }>({ chapterId: null, chapterName: null });
  const [newChapter, setNewChapter] = useState<string | null>(null);
  const { data: chapters } = useChapters(workspaceId);

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
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<z.infer<typeof nameSchema>>({
    defaultValues: { quizName: topicLabel },
    resolver: zodResolver(nameSchema),
  });

  function pickTarget(next: QuizTarget | null) {
    // Renaming a new quiz keeps its chapter; any other pick starts over.
    if (!(target?.kind === 'new' && next?.kind === 'new')) resetChapter();
    setTarget(next);
    if (next?.kind === 'new') setValue('quizName', next.name);
  }
  function resetChapter() {
    setPicked({ chapterId: null, chapterName: null });
    setNewChapter(null);
  }
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
        <>
          <Button onClick={onClose} size="lg" variant="ghost-hover">
            {m.action_cancel()}
          </Button>
          <Button
            disabled={isPending || !workspaceId || !target}
            size="lg"
            type="submit"
            variant="accent"
          >
            {m.action_copy()}
          </Button>
        </>
      }
      onClose={onClose}
      // Focus the dialog, not a field: a focused quiz picker opens its list.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        (event.currentTarget as HTMLElement).focus();
      }}
      onSubmit={(event) => {
        if (target?.kind === 'new')
          return handleSubmit(({ quizName }) =>
            submit({ ...newQuizChapter(), quizName })
          )(event);
        event.preventDefault();
        if (target) void submit({ quizId: target.quiz.id });
      }}
      open
      title={m.question_ui_copy_to_quiz()}
      width={560}
    >
      {/* The form draws while workspaces load, so nothing shifts when they land. */}
      {workspacesPending || editable.length ? (
        <div className="flex flex-col gap-4">
          <SettingRow title={m.question_ui_workspace()}>
            <Select
              onValueChange={(id) => {
                setPickedWorkspaceId(id);
                // A named new quiz moves with the workspace; a picked one can't.
                // Chapters belong to the old workspace.
                resetChapter();
                if (target?.kind !== 'new') setTarget(null);
              }}
              value={workspaceId}
            >
              <SelectTrigger
                aria-label={m.question_ui_workspace()}
                className="sm:w-56"
                disabled={workspacesPending}
                loading={workspacesPending}
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
            <InputTitle
              count={
                target?.kind === 'new'
                  ? {
                      max: copyBankQuestionsBodyQuizNameMax,
                      value: textLength(target.name),
                    }
                  : undefined
              }
            >
              {m.question_ui_quiz()}
            </InputTitle>
            {target?.kind === 'new' && (
              <p className="t-meta -mt-1 text-fg-muted">
                {m.question_ui_new_quiz()}
              </p>
            )}
            <QuizTargetSelect
              disabled={!workspaceId}
              invalid={target?.kind === 'new' && !!errors.quizName}
              key={workspaceId}
              onChange={pickTarget}
              value={target}
              workspaceId={workspaceId}
            />
            <InputError>
              {target?.kind === 'new' && errors.quizName?.message}
            </InputError>
          </div>
          {/* Hidden, not removed, until a quiz is picked: no layout shift. */}
          <div aria-hidden={!target} className={cn(!target && 'invisible')}>
            <SettingRow title={m.question_ui_chapter()}>
              {target?.kind === 'new' && newChapter !== null ? (
                <NewChapterInput
                  field
                  onCancel={() => setNewChapter(null)}
                  onChange={setNewChapter}
                  onConfirm={() => {
                    const name = newChapter.trim();
                    if (!name) return;
                    setPicked(chapterByName(chapters, name));
                    setNewChapter(null);
                  }}
                  value={newChapter}
                />
              ) : target?.kind === 'existing' ? (
                <ChapterSelect
                  chapterName={target.quiz.chapterName || null}
                  chapters={chapters ?? []}
                  disabled
                  field
                  onChange={() => {}}
                  value={target.quiz.chapterId}
                />
              ) : (
                <ChapterSelect
                  chapterName={picked.chapterName}
                  chapters={chapters ?? []}
                  field
                  onChange={(chapterId) =>
                    setPicked({ chapterId, chapterName: null })
                  }
                  onCreateRequest={() => setNewChapter('')}
                  value={picked.chapterId}
                />
              )}
            </SettingRow>
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
