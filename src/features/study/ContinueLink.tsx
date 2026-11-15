import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { attemptQuery, useMe } from '@/api/hooks';
import type { HistoryRow } from '@/api/types';
import { keepFlashcardRun } from '@/features/flashcards/flashcardRun';
import { PREF_KEYS, writePref } from '@/lib/localPrefs';

/** Goes on where `row` stopped: an unfinished revision continues its
 * session; a quiz or set continues the recorded try, kept in this browser
 * first, so it goes on here whichever device began it. */
export function ContinueLink({
  children,
  className,
  row: r,
}: {
  children: ReactNode;
  className?: string;
  row: HistoryRow;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useMe();
  if (r.kind === 'revision')
    return (
      <Link
        className={className}
        params={{ workspaceId: r.workspaceId ?? '' }}
        search={{ from: 'review' as const, session: r.id }}
        to="/learning/review/$workspaceId"
      >
        {children}
      </Link>
    );
  const materialId = r.materialId ?? '';
  if (r.kind === 'quiz')
    return (
      <Link
        className={className}
        onClick={() =>
          writePref(PREF_KEYS.quizAttempt('account', materialId), r.id)
        }
        params={{ quizId: materialId }}
        to="/quizzes/$quizId/attempt"
      >
        {children}
      </Link>
    );
  // A set resumes the run this browser keeps: keep the recorded one, read
  // from the server, before opening the set.
  return (
    <Link
      className={className}
      onClick={async (event) => {
        event.preventDefault();
        try {
          const attempt = await qc.fetchQuery(attemptQuery(r.id));
          if (me)
            keepFlashcardRun(me.id, materialId, {
              cards: attempt.cards,
              id: attempt.id,
              startedAt: attempt.startedAt ?? attempt.takenAt,
              takenAt: attempt.takenAt,
            });
        } finally {
          void navigate({
            params: { flashcardSetId: materialId },
            to: '/flashcards/$flashcardSetId',
          });
        }
      }}
      params={{ flashcardSetId: materialId }}
      to="/flashcards/$flashcardSetId"
    >
      {children}
    </Link>
  );
}
