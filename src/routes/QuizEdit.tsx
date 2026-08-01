import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useQuiz, useUpdateQuiz } from '@/api/hooks';
import type { Question } from '@/api/types';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { QuizForm } from '@/features/quizzes/QuizForm';

export default function QuizEdit() {
  const params = useParams({ strict: false });
  const quizId = (params as { quizId: string }).quizId;
  const navigate = useNavigate();
  const { data: quiz, isLoading } = useQuiz(quizId);
  const update = useUpdateQuiz();

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
      await update.mutateAsync({ id: quizId, name, questions });
      back();
    } catch (err) {
      userToast({
        description:
          err instanceof Error ? err.message : 'Something went wrong.',
        title: 'Could not save quiz',
        variant: 'error',
      });
    }
  }

  return (
    <PanelWithInvertedRadius>
      <PageHeader
        actions={
          <>
            <Button
              disabled={update.isPending}
              iconLeft="chevronLeft"
              onClick={back}
              variant="ghost"
            >
              Back
            </Button>
            <Button
              disabled={update.isPending || !seeded.current}
              iconLeft="check"
              onClick={save}
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
        title={name || 'Edit quiz'}
      />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {isLoading || !seeded.current ? (
          <Skeleton className="h-64 w-full" />
        ) : quiz ? (
          <div className="mx-auto max-w-2xl">
            <QuizForm
              name={name}
              onNameChange={setName}
              onQuestionsChange={setQuestions}
              questions={questions}
            />
          </div>
        ) : (
          <p className="py-8 text-center text-fg-muted">Quiz not found.</p>
        )}
      </div>
    </PanelWithInvertedRadius>
  );
}
