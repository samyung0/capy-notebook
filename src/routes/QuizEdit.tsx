import { useNavigate, useParams } from '@tanstack/react-router';
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
import { QuizForm } from '@/features/quizzes/QuizForm';
import { m } from '@/i18n';

export default function QuizEdit() {
  const params = useParams({ strict: false });
  const quizId = (params as { quizId: string }).quizId;
  const navigate = useNavigate();
  const { data: quiz, fetchStatus, isLoading } = useQuiz(quizId);
  const { isPending: contentIsPending, mutateAsync: updateContent } =
    useUpdateQuizContent();
  const { isPending: metadataIsPending, mutateAsync: updateMetadata } =
    useUpdateQuizMetadata();
  const updateIsPending = contentIsPending || metadataIsPending;

  const [name, setName] = useState('');
  const [questions, setQuestions] = useState<Question[]>([]);
  const seeded = useRef(false);

  // Seed local editor state once the quiz loads (subsequent edits stay local).
  useEffect(() => {
    if (quiz && !seeded.current) {
      setName(quiz.name);
      setQuestions(structuredClone(quiz.questions));
      seeded.current = true;
    }
  }, [quiz]);

  function back() {
    navigate({ to: '/quizzes' });
  }

  async function save() {
    try {
      await updateContent({ id: quizId, questions });
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
              iconLeft="chevronLeft"
              onClick={back}
              variant="ghost"
            >
              {m.action_back()}
            </Button>
            <Button
              disabled={updateIsPending || !seeded.current}
              iconLeft="check"
              onClick={save}
            >
              {updateIsPending ? m.canvas_saving() : m.action_save()}
            </Button>
          </>
        }
        title={name || m.quiz_edit()}
      />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {fetchStatus === 'paused' ? (
          <QueryPausedState />
        ) : isLoading || !seeded.current ? (
          <Skeleton className="h-64 w-full" />
        ) : quiz?.canEdit ? (
          <div className="mx-auto max-w-2xl">
            <QuizForm
              name={name}
              onNameChange={setName}
              onQuestionsChange={setQuestions}
              questions={questions}
            />
          </div>
        ) : (
          <p className="py-8 text-center text-fg-muted">{m.quiz_not_found()}</p>
        )}
      </div>
    </PanelWithInvertedRadius>
  );
}
