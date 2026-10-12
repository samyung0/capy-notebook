import { useEffect, useRef, useState } from 'react';
import { useQuizEdit, useUpdateQuizContent } from '@/api/hooks';
import type { Question } from '@/api/types';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/feedback';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { m } from '@/i18n';
import { QuizForm } from './QuizForm';
import { usePickedImages } from './usePickedImages';

/** Edits a quiz's questions in place, the way FlashcardsEditor edits a set:
 * staged, changes wait for Save (with the revision the editing started from)
 * and Reset drops them; saved each change, every edit goes out at once.
 * The answer key loads here, since material reads carry learner questions. */
export function QuizEditor({
  quizId,
  title,
  onEmpty,
  saveEachChange,
}: {
  quizId: string;
  /** Shown above the questions; empty where the surrounding view names it. */
  title: string;
  /** Inside a note: removing the last question removes the block instead. */
  onEmpty?: () => void;
  /** Inside a note: every change saves at once (no Reset or Save). */
  saveEachChange?: boolean;
}) {
  const { data: quiz, fetchStatus, isFetchedAfterMount } = useQuizEdit(quizId);
  const { isPending: savePending, mutateAsync: updateContent } =
    useUpdateQuizContent();
  const [base, setBase] = useState<Question[] | null>(null);
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [confirm, setConfirm] = useState<'reset' | 'save' | null>(null);
  const revision = useRef<number | null>(null);
  const saving = useRef(Promise.resolve());
  const {
    isPending: uploadPending,
    pick,
    previewUrl,
    uploadPicked,
  } = usePickedImages(quizId, setQuestions);
  const isPending = savePending || uploadPending;

  // Seed once the fresh read lands; later edits stay local. A failed refresh
  // seeds from the cached quiz.
  useEffect(() => {
    if (!quiz || !isFetchedAfterMount || revision.current !== null) return;
    setBase(quiz.questions);
    setQuestions(structuredClone(quiz.questions));
    revision.current = quiz.revision;
  }, [quiz, isFetchedAfterMount]);

  async function save(next: Question[]) {
    if (revision.current === null) return;
    try {
      const uploaded = await uploadPicked(next);
      const saved = await updateContent({
        expectedRevision: revision.current,
        id: quizId,
        questions: uploaded,
      });
      revision.current = saved.revision;
      setBase(uploaded);
      setConfirm(null);
    } catch {
      // The global mutation handler shows the normalized failure.
    }
  }
  function change(next: Question[]) {
    if (saveEachChange && onEmpty && next.length === 0) return onEmpty();
    setQuestions(next);
    // One save at a time, each with the revision the previous one returned.
    if (saveEachChange) saving.current = saving.current.then(() => save(next));
  }

  if (fetchStatus === 'paused' && !questions) return <QueryPausedState />;
  if (!questions || !base) return <Skeleton className="h-64 w-full" />;
  const dirty = JSON.stringify(questions) !== JSON.stringify(base);
  return (
    <AssetUrlContext.Provider value={previewUrl}>
      <div className="flex flex-col gap-7">
        {title && <h1 className="t-large-card-title">{title}</h1>}
        <QuizForm
          name={title}
          onQuestionsChange={change}
          questions={questions}
          uploadAsset={pick}
        />
        {!saveEachChange && (
          <div className="flex justify-end gap-2">
            <Button
              disabled={!dirty || isPending}
              onClick={() => setConfirm('reset')}
              size="lg"
              variant="danger-light"
            >
              {m.action_reset()}
            </Button>
            <Button
              disabled={!dirty || isPending}
              onClick={() => setConfirm('save')}
              size="lg"
              variant="accent"
            >
              {m.action_save()}
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        body={m.edit_reset_confirm_body()}
        confirmLabel={m.action_reset()}
        onClose={() => setConfirm(null)}
        onConfirm={() => setQuestions(structuredClone(base))}
        open={confirm === 'reset'}
        title={m.edit_reset_confirm_title()}
      />
      <ConfirmDialog
        body={m.edit_save_confirm_body()}
        closeOnConfirm={false}
        confirmLabel={m.action_save()}
        danger={false}
        isSubmitting={isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => void save(questions)}
        open={confirm === 'save'}
        title={m.edit_save_confirm_title()}
      />
    </AssetUrlContext.Provider>
  );
}
