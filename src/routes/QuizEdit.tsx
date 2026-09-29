import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import {
  useQuiz,
  useUpdateQuizContent,
  useUpdateQuizMetadata,
} from '@/api/hooks';
import type { Question } from '@/api/types';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { QuizForm } from '@/features/quizzes/QuizForm';
import { m } from '@/i18n';

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

  const [name, setName] = useState('');
  const [questions, setQuestions] = useState<Question[]>([]);
  const seeded = useRef(false);
  const revision = useRef<number | null>(null);

  // Seed local editor state once the quiz loads (subsequent edits stay local).
  useEffect(() => {
    if (quiz && isFetchedAfterMount && !isError && !seeded.current) {
      setName(quiz.name);
      setQuestions(structuredClone(quiz.questions));
      revision.current = quiz.revision;
      seeded.current = true;
    }
  }, [quiz, isFetchedAfterMount, isError]);

  function back() {
    void navigate({ href: returnTo ?? '/create' });
  }

  async function save() {
    try {
      if (revision.current === null || !quiz?.canEditContent || updateIsPending)
        return;
      const saved = await updateContent({
        expectedRevision: revision.current,
        id: quizId,
        questions,
      });
      revision.current = saved.revision;
      await updateMetadata({ id: quizId, name });
      back();
    } catch {
      // The global mutation handler shows the normalized failure.
    }
  }

  return (
    <PanelWithInvertedRadius>
      <PageHeader
        actions={
          <>
            <Button
              disabled={updateIsPending}
              iconLeft="navigationBack"
              onClick={back}
              variant="ghost"
            >
              {m.action_back()}
            </Button>
            <Button
              disabled={
                updateIsPending || !seeded.current || !quiz?.canEditContent
              }
              iconLeft="check"
              onClick={save}
            >
              {updateIsPending ? m.canvas_saving() : m.action_save()}
            </Button>
          </>
        }
        className="flex-wrap gap-3 px-4 sm:gap-6 sm:px-6"
        title={name || m.quiz_edit()}
        titleClassName="w-full sm:w-auto"
      />
      <div className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6">
        {fetchStatus === 'paused' ? (
          <QueryPausedState />
        ) : isError ? (
          <p role="alert">{m.quiz_unable_load()}</p>
        ) : isLoading || !seeded.current ? (
          <Skeleton className="h-64 w-full" />
        ) : quiz?.canEditContent ? (
          <div className="mx-auto max-w-2xl">
            <QuizForm
              name={name}
              onNameChange={setName}
              onQuestionsChange={setQuestions}
              questions={questions}
            />
            <MaterialAttributionFooter provenance={quiz.provenance} />
          </div>
        ) : (
          <p className="py-8 text-center text-fg-muted">{m.quiz_not_found()}</p>
        )}
      </div>
    </PanelWithInvertedRadius>
  );
}
