import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { UpdateQuizMetadataBody } from '@/api/gen/validators';
import {
  useQuiz,
  useUpdateQuizContent,
  useUpdateQuizMetadata,
} from '@/api/hooks';
import type { Question } from '@/api/types';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TabContent } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { Input, InputField } from '@/components/ui/Input';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { QuizForm } from '@/features/quizzes/QuizForm';
import { QuizPageHeader } from '@/features/quizzes/QuizPage';
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
  } = useQuiz(quizId, { fresh: true });
  const { isPending: contentIsPending, mutateAsync: updateContent } =
    useUpdateQuizContent();
  const { isPending: metadataIsPending, mutateAsync: updateMetadata } =
    useUpdateQuizMetadata();
  const updateIsPending = contentIsPending || metadataIsPending;

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
    void navigate({ href: returnTo ?? '/create' });
  }

  const save = handleSubmit(async ({ name: nextName }) => {
    try {
      if (revision.current === null || !quiz?.canEditContent || updateIsPending)
        return;
      const saved = await updateContent({
        expectedRevision: revision.current,
        id: quizId,
        questions,
      });
      revision.current = saved.revision;
      await updateMetadata({ id: quizId, name: nextName });
      back();
    } catch {
      // The global mutation handler shows the normalized failure.
    }
  });

  const saveDisabled =
    updateIsPending || !seeded.current || !quiz?.canEditContent;
  return (
    <PanelWithInvertedRadius>
      <QuizPageHeader
        onBack={updateIsPending ? undefined : back}
        title={m.quiz_edit()}
        trail={
          quiz ? [quiz.workspaceName || m.nav_create(), name || quiz.name] : []
        }
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
            <section className="grid gap-4">
              <div className="flex flex-col gap-1">
                <h2 className="t-card-title">{m.quiz_details()}</h2>
                <p className="text-fg-secondary">{m.quiz_details_hint()}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <InputField
                  error={errors.name}
                  id="quiz-name"
                  label={m.common_name()}
                >
                  <Input id="quiz-name" {...register('name')} />
                </InputField>
              </div>
            </section>
            <h2 className="t-card-title mt-8 mb-6">{m.quiz_questions()}</h2>
            <QuizForm
              name={name}
              onQuestionsChange={setQuestions}
              questions={questions}
            />
            <Button
              className="mt-3 rounded-input"
              disabled={saveDisabled}
              fullWidth
              iconLeft="check"
              onClick={() => void save()}
              size="lg"
            >
              {updateIsPending ? m.canvas_saving() : m.action_save()}
            </Button>
            <MaterialAttributionFooter provenance={quiz.provenance} />
          </>
        ) : (
          <p className="py-8 text-center text-fg-muted">{m.quiz_not_found()}</p>
        )}
      </TabContent>
    </PanelWithInvertedRadius>
  );
}
