import { type ReactNode, useEffect, useState } from 'react';
import { anonymousAssetUrl, gradeAnonymousQuiz } from '@/api/anonymous';
import type { AnonymousQuiz } from '@/api/types';
import { PublicActionMenu } from '@/components/app/PublicActionMenu';
import { PublicByline, PublicPage } from '@/components/app/PublicHeader';
import { userToast } from '@/components/ui/userToast';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { useLocalRun } from '@/features/quizzes/quizRun';
import { m } from '@/i18n';
import { type LocalQuizAttempt, localQuizAttempts } from '@/lib/localDb';

function Frame({
  children,
  header,
}: {
  children: ReactNode;
  header?: ReactNode;
}) {
  return (
    <PublicPage>
      {header}
      {children}
    </PublicPage>
  );
}

/** `/share/quizzes/{token}`: the Worker renders it from the same edge-cached
 * data for every visitor and the browser hydrates it. Nothing here counts, signed
 * in or out (Epo 2026-11-03, Q640 B): the share route marks what has one right
 * answer, open answers stay Not marked, and only this browser keeps the try. */
export function SharedQuiz({
  quiz,
  token,
}: {
  quiz: AnonymousQuiz;
  token: string;
}) {
  const [past, setPast] = useState<LocalQuizAttempt[]>([]);
  const quizId = quiz.id;
  useEffect(() => {
    localQuizAttempts(quizId)
      .then(setPast)
      .catch(() => setPast([]));
  }, [quizId]);

  const control = useLocalRun(
    quiz,
    past,
    (questionId, answers) => gradeAnonymousQuiz(token, { answers, questionId }),
    (attempt) =>
      setPast((current) => [
        attempt,
        ...current.filter((a) => a.id !== attempt.id),
      ]),
    () => userToast({ title: m.quiz_browser_save_failed(), variant: 'error' })
  );

  return (
    <AssetUrlContext.Provider
      value={(assetId) => anonymousAssetUrl(token, assetId)}
    >
      <AttemptBody
        actions={<PublicActionMenu kind="quiz" token={token} />}
        byline={
          <PublicByline author={quiz.author} updatedAt={quiz.updatedAt} />
        }
        control={control}
        footer={
          <div className="mt-6 grid gap-2 text-fg-muted">
            <p className="t-meta">{m.quiz_saved_in_browser()}</p>
            {past.length > 0 && (
              <>
                <p className="t-meta font-semibold">{m.quiz_past_attempts()}</p>
                <ul className="t-meta grid gap-1">
                  {past.map((attempt) => (
                    <li key={attempt.id}>
                      {new Date(attempt.takenAt).toLocaleString()} ·{' '}
                      {attempt.correct} / {attempt.total}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        }
        frame={Frame}
        name={quiz.name}
        neverMarks
        provenance={quiz.provenance}
        questions={quiz.questions}
        trail={[]}
      />
    </AssetUrlContext.Provider>
  );
}
