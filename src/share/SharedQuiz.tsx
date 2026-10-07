import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import {
  anonymousAssetUrl,
  anonymousQuizQuery,
  gradeAnonymousQuiz,
} from '@/api/anonymous';
import { api } from '@/api/client';
import type { AttemptDetail } from '@/api/types';
import { PublicActionMenu } from '@/components/app/PublicActionMenu';
import { PublicByline, PublicPage } from '@/components/app/PublicHeader';
import { Skeleton } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { m } from '@/i18n';
import {
  anonymousId,
  type LocalQuizAttempt,
  localQuizAttempts,
  saveLocalQuizAttempt,
} from '@/lib/localDb';
import { failureStatus, ShareError } from './ShareError';
import { signedIn, useSignedIn } from './session';

function Frame({ children }: { children: ReactNode }) {
  return <PublicPage>{children}</PublicPage>;
}

/** `/share/quizzes/{token}`: every visitor takes the quiz from the same cached
 * data. Submitting asks the session: signed in, the attempt is graded and kept
 * on the account; signed out, the share route grades it and this browser keeps
 * it. */
export function SharedQuiz({ token }: { token: string }) {
  const {
    data: quiz,
    error,
    isError,
    isLoading,
  } = useQuery({
    ...anonymousQuizQuery(token),
    // Failures render the summary's failure panel here, not the boundary.
    meta: { errorBoundary: false },
    retry: false,
  });
  const session = useSignedIn();
  const [past, setPast] = useState<LocalQuizAttempt[]>([]);
  const quizId = quiz?.id;
  useEffect(() => {
    if (!quizId || session !== false) return;
    localQuizAttempts(quizId)
      .then(setPast)
      .catch(() => setPast([]));
  }, [quizId, session]);

  if (isLoading)
    return (
      <Frame>
        <Skeleton className="h-[60vh] w-full" />
      </Frame>
    );
  if (isError || !quiz) return <ShareError status={failureStatus(error)} />;

  return (
    <AssetUrlContext.Provider
      value={(assetId) => anonymousAssetUrl(token, assetId)}
    >
      <AttemptBody
        actions={<PublicActionMenu id={quiz.id} kind="quiz" />}
        byline={<PublicByline author={quiz.author} />}
        footer={
          // Signed-in attempts live on the account, so only signed-out
          // visitors get the browser note and their past attempts.
          session === false && (
            <div className="mt-6 grid gap-2 text-fg-muted">
              <p className="t-meta">{m.quiz_saved_in_browser()}</p>
              {past.length > 0 && (
                <>
                  <p className="t-meta font-semibold">
                    {m.quiz_past_attempts()}
                  </p>
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
          )
        }
        frame={Frame}
        grade={async (answers) => {
          if (await signedIn()) {
            const attempt = await api.post<AttemptDetail>(
              `/quizzes/${quiz.id}/attempts`,
              { answers }
            );
            return {
              awarded: attempt.correct,
              max: attempt.total,
              questions: attempt.questions,
            };
          }
          const graded = await gradeAnonymousQuiz(token, {
            answers,
            localId: await anonymousId().catch(() => undefined),
          });
          const attempt: LocalQuizAttempt = {
            answers,
            correct: graded.awarded,
            id: crypto.randomUUID(),
            questions: graded.questions,
            quizId: quiz.id,
            quizName: quiz.name,
            takenAt: new Date().toISOString(),
            total: graded.max,
          };
          saveLocalQuizAttempt(attempt)
            .then(() => setPast((current) => [attempt, ...current]))
            .catch(() =>
              userToast({
                title: m.quiz_browser_save_failed(),
                variant: 'error',
              })
            );
          return graded;
        }}
        name={quiz.name}
        provenance={quiz.provenance}
        questions={quiz.questions}
        trail={[]}
      />
    </AssetUrlContext.Provider>
  );
}
