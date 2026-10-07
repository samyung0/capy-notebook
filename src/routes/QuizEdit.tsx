import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { UpdateQuizMetadataBody } from '@/api/gen/validators';
import {
  useQuizEdit,
  useUpdateQuizContent,
  useUpdateQuizMetadata,
} from '@/api/hooks';
import type { Question } from '@/api/types';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { TabContent, TabHeader } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Skeleton, Spinner } from '@/components/ui/feedback';
import { Input, InputField } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { QuizForm } from '@/features/quizzes/QuizForm';
import { QuizPageHeader } from '@/features/quizzes/QuizPage';
import { usePickedImages } from '@/features/quizzes/usePickedImages';
import { m } from '@/i18n';

const detailsSchema = z.object({
  name: UpdateQuizMetadataBody.shape.name.unwrap(),
});

export default function QuizEdit() {
  const params = useParams({ strict: false });
  const quizId = (params as { quizId: string }).quizId;
  return <QuizEditor key={quizId} quizId={quizId} />;
}

function QuizEditor({ quizId }: { quizId: string }) {
  const navigate = useNavigate();
  const { returnTo } = useSearch({ from: '/auth-shell/quizzes/$quizId/edit' });
  const {
    data: quiz,
    fetchStatus,
    isLoading,
    isFetchedAfterMount,
    isError,
  } = useQuizEdit(quizId);
  const { isPending: contentIsPending, mutateAsync: updateContent } =
    useUpdateQuizContent();
  const { isPending: metadataIsPending, mutateAsync: updateMetadata } =
    useUpdateQuizMetadata();
  const {
    isPending: uploadIsPending,
    pick,
    previewUrl,
    uploadPicked,
  } = usePickedImages(quizId, (next) => setQuestions(next));
  const updateIsPending =
    uploadIsPending || contentIsPending || metadataIsPending;

  const {
    control,
    handleSubmit,
    register,
    reset,
    formState: { errors },
  } = useForm<z.infer<typeof detailsSchema>>({
    defaultValues: { name: '' },
    resolver: zodResolver(detailsSchema),
  });
  const name = useWatch({ control, name: 'name' });
  const [tab, setTab] = useState('questions');
  const [confirm, setConfirm] = useState<'reset' | 'save' | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const seeded = useRef(false);
  const revision = useRef<number | null>(null);

  // Seed local editor state once the quiz loads (subsequent edits stay local).
  useEffect(() => {
    if (quiz && isFetchedAfterMount && !isError && !seeded.current) {
      reset({ name: quiz.name });
      setQuestions(structuredClone(quiz.questions));
      revision.current = quiz.revision;
      seeded.current = true;
    }
  }, [quiz, isFetchedAfterMount, isError, reset]);

  function back() {
    void navigate({ href: returnTo ?? '/files?tab=blocks' });
  }

  const save = handleSubmit(
    async ({ name: nextName }) => {
      try {
        if (
          revision.current === null ||
          !quiz?.canEditContent ||
          updateIsPending
        )
          return;
        const saved = await updateContent({
          expectedRevision: revision.current,
          id: quizId,
          questions: await uploadPicked(questions),
        });
        revision.current = saved.revision;
        await updateMetadata({ id: quizId, name: nextName });
        back();
      } catch {
        // The global mutation handler shows the normalized failure.
      }
    },
    () => {
      setConfirm(null);
      setTab('general');
    }
  );

  // Back to what the editor loaded; picked images not yet saved are dropped.
  function resetEdits() {
    if (!quiz) return;
    reset({ name: quiz.name });
    setQuestions(structuredClone(quiz.questions));
  }
  const dirty =
    !!quiz &&
    (name !== quiz.name ||
      JSON.stringify(questions) !== JSON.stringify(quiz.questions));

  const saveDisabled =
    updateIsPending || !seeded.current || !quiz?.canEditContent;
  return (
    <PanelWithInvertedRadius>
      <QuizPageHeader
        className="px-6 pt-6 pb-2 sm:px-6 sm:pt-6 lg:px-6 xl:px-6"
        onBack={updateIsPending ? undefined : back}
        title={m.quiz_edit()}
        topBar={<TopInsetBar className="hidden shrink-0 lg:flex" />}
        trail={
          quiz
            ? [quiz.workspaceName || m.files_tab_blocks(), name || quiz.name]
            : []
        }
      />
      <Tabs
        className="px-6"
        onChange={setTab}
        tabs={[
          { label: m.quiz_questions(), value: 'questions' },
          { label: m.settings_tab_general(), value: 'general' },
        ]}
        value={tab}
      />
      <TabContent>
        {fetchStatus === 'paused' ? (
          <QueryPausedState />
        ) : isError ? (
          <p role="alert">{m.quiz_unable_load()}</p>
        ) : isLoading || !seeded.current ? (
          <Skeleton className="h-64 w-full" />
        ) : quiz?.canEditContent ? (
          <>
            {tab === 'general' ? (
              <>
                <TabHeader
                  description={m.quiz_details_hint()}
                  title={m.settings_tab_general()}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <InputField
                    error={errors.name}
                    id="quiz-name"
                    label={m.quiz_name()}
                  >
                    <Input id="quiz-name" {...register('name')} />
                  </InputField>
                </div>
              </>
            ) : (
              <>
                <h2 className="t-card-title mb-7">{m.quiz_questions()}</h2>
                <AssetUrlContext.Provider value={previewUrl}>
                  <QuizForm
                    name={name}
                    onQuestionsChange={setQuestions}
                    questions={questions}
                    uploadAsset={pick}
                  />
                </AssetUrlContext.Provider>
              </>
            )}
            <div className="mt-8 flex justify-end gap-2">
              <Button
                disabled={saveDisabled || !dirty}
                onClick={() => setConfirm('reset')}
                size="lg"
                variant="danger-light"
              >
                {m.action_reset()}
              </Button>
              <Button
                aria-label={m.action_save()}
                disabled={saveDisabled}
                onClick={() => setConfirm('save')}
                size="lg"
                variant="accent"
              >
                {updateIsPending ? <Spinner /> : m.action_save()}
              </Button>
            </div>
            <ConfirmDialog
              body={m.edit_reset_confirm_body()}
              confirmLabel={m.action_reset()}
              onClose={() => setConfirm(null)}
              onConfirm={resetEdits}
              open={confirm === 'reset'}
              title={m.edit_reset_confirm_title()}
            />
            <ConfirmDialog
              body={m.edit_save_confirm_body()}
              closeOnConfirm={false}
              confirmLabel={m.action_save()}
              danger={false}
              isSubmitting={updateIsPending}
              onClose={() => setConfirm(null)}
              onConfirm={() => void save()}
              open={confirm === 'save'}
              title={m.edit_save_confirm_title()}
            />
            <MaterialAttributionFooter provenance={quiz.provenance} />
          </>
        ) : (
          <p className="py-8 text-center text-fg-muted">{m.quiz_not_found()}</p>
        )}
      </TabContent>
    </PanelWithInvertedRadius>
  );
}
