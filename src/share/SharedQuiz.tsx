import { type ReactNode, useEffect, useState } from 'react';
import { anonymousAssetUrl, gradeAnonymousQuiz } from '@/api/anonymous';
import type { AnonymousQuiz } from '@/api/types';
import { PublicActionMenu } from '@/components/app/PublicActionMenu';
import { PublicByline, PublicPage } from '@/components/app/PublicHeader';
import { userToast } from '@/components/ui/userToast';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import {
  type QuizRunControl,
  useLocalRun,
  useSharedAccountRun,
} from '@/features/quizzes/quizRun';
import { m } from '@/i18n';
import {
  anonymousId,
  type LocalQuizAttempt,
  localQuizAttempts,
} from '@/lib/localDb';
import { redeemShareToken } from '@/lib/shareRedeem';
import { signedIn, useSignedIn } from './session';
import { useTurnstileCheck } from './TurnstileCheck';

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
 * data for every visitor and the browser hydrates it. Each check asks the
 * session: signed in, the question is graded and kept in the account's
 * attempt; signed out, the share route grades it and this browser keeps it. */
export function SharedQuiz({
  quiz,
  token,
}: {
  quiz: AnonymousQuiz;
  token: string;
}) {
  const session = useSignedIn();
  const turnstile = useTurnstileCheck();
  const [past, setPast] = useState<LocalQuizAttempt[]>([]);
  const quizId = quiz.id;
  useEffect(() => {
    if (session !== false) return;
    localQuizAttempts(quizId)
      .then(setPast)
      .catch(() => setPast([]));
  }, [quizId, session]);

  // A signed-in visitor presents the link once, then the attempt is the
  // account's; a signed-out one is graded by the link and kept here.
  const account = useSharedAccountRun(quizId, () => redeemShareToken(token));
  const local = useLocalRun(
    quiz,
    past,
    async (questionId, answers) =>
      gradeAnonymousQuiz(token, {
        answers,
        localId: await anonymousId().catch(() => undefined),
        questionId,
        // Only a signed-out check carries a Turnstile token.
        turnstileToken: await turnstile.take(),
      }),
    (attempt) =>
      setPast((current) => [
        attempt,
        ...current.filter((a) => a.id !== attempt.id),
      ]),
    () => userToast({ title: m.quiz_browser_save_failed(), variant: 'error' })
  );
  const control: QuizRunControl = {
    async check(questionId, answers) {
      // The session as the page shows it, once known.
      const run = (session ?? (await signedIn())) ? account : local;
      await run.check(questionId, answers);
    },
    redo: () => (session === true ? account : local).redo(),
    run: session === true ? account.run : local.run,
  };

  return (
    <AssetUrlContext.Provider
      value={(assetId) => anonymousAssetUrl(token, assetId)}
    >
      <AttemptBody
        actions={<PublicActionMenu kind="quiz" token={token} />}
        belowCheck={turnstile.view}
        byline={
          <PublicByline author={quiz.author} updatedAt={quiz.updatedAt} />
        }
        control={control}
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
        name={quiz.name}
        provenance={quiz.provenance}
        questions={quiz.questions}
        trail={[]}
      />
    </AssetUrlContext.Provider>
  );
}
