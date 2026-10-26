import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, isApiError, qk } from '@/api/client';
import { useAttempt, useCheckQuizQuestion } from '@/api/hooks';
import { isMissing } from '@/api/queryClient';
import type {
  AttemptDetail,
  CheckQuizQuestionReq,
  GradedQuestion,
  Question,
} from '@/api/types';
import type { LearnerQuestion } from '@/features/questions/types';
import { type LocalQuizAttempt, saveLocalQuizAttempt } from '@/lib/localDb';
import { isString, PREF_KEYS, useLocalPref } from '@/lib/localPrefs';
import { type Answers, runScore } from './grade';

/** One try at a quiz: the questions checked so far, graded, with the answers
 * sent for them. Unchecked questions score 0, and a try left partway still
 * counts as an attempt. */
export type QuizRun = {
  /** Null on an account attempt whose browser clock ran ahead of the server. */
  startedAt: string | null;
  /** The latest check, for the minutes a finished try shows; null before the
   * first. */
  takenAt: string | null;
  answers: Answers;
  checked: Question[];
};

/** How the quiz page checks questions. The page sends one check at a time
 * and offers no Reset while one is in flight, so a check always builds on the
 * run the page shows. */
export type QuizRunControl = {
  run: QuizRun;
  /** Grades one question and adds it to the run. */
  check: (questionId: string, answers: Answers) => Promise<void>;
  /** Starts a new try. */
  redo: () => void;
};

const newLocalRun = (): LocalRun => ({
  answers: {},
  checked: [],
  startedAt: new Date().toISOString(),
  takenAt: null,
});
const newRun = (): QuizRun => newLocalRun();

/** A browser-kept run, which always knows when it began. */
type LocalRun = QuizRun & { startedAt: string };

/** Adds a checked question; the page shows them in the quiz's order. */
const addChecked = <R extends QuizRun>(
  run: R,
  question: Question,
  answers: Answers
): R & { takenAt: string } => ({
  ...run,
  answers: { ...run.answers, ...answers },
  checked: [...run.checked.filter((q) => q.id !== question.id), question],
  takenAt: new Date().toISOString(),
});

/**
 * A signed-in try, recorded on the account. This browser keeps the attempt's
 * id, so a reload or a later visit continues it; its checked questions come
 * from the attempt's persisted query. An id the server no longer knows starts
 * a new attempt on the next check, whose id replaces it; a kept attempt that
 * is gone (404) is forgotten. A check the attempt already holds (409: a lost
 * response, another tab) reads the attempt again instead of failing.
 */
export function useQuizRun(
  quizId: string,
  {
    enabled = true,
    beforeCheck,
  }: { enabled?: boolean; beforeCheck?: () => Promise<unknown> } = {}
): QuizRunControl {
  const qc = useQueryClient();
  const [attemptId, setAttemptId] = useLocalPref(
    PREF_KEYS.quizAttempt('account', quizId),
    '',
    isString
  );
  const [fresh, setFresh] = useState(newRun);
  const { data, error } = useAttempt(enabled ? attemptId : '', {
    errorBoundary: false,
  });
  const gone = isMissing(error);
  useEffect(() => {
    if (!gone) return;
    qc.removeQueries({ exact: true, queryKey: qk.attempt(attemptId) });
    setAttemptId('');
  }, [gone]);
  const { mutateAsync } = useCheckQuizQuestion({ errorToast: false });
  const run: QuizRun =
    !gone && data && data.id === attemptId
      ? {
          // The answers the server graded, as this page sent them.
          answers: data.answers as Answers,
          checked: data.questions,
          startedAt: data.startedAt,
          takenAt: data.takenAt,
        }
      : fresh;
  return {
    async check(questionId, answers) {
      await beforeCheck?.();
      try {
        const attempt = await mutateAsync({
          answers,
          attemptId: attemptId || undefined,
          questionId,
          quizId,
          startedAt: run.startedAt ?? undefined,
        });
        if (attempt.id !== attemptId) setAttemptId(attempt.id);
      } catch (err) {
        if (!(isApiError(err) && err.status === 409)) throw err;
        await qc.refetchQueries({
          exact: true,
          queryKey: qk.attempt(attemptId),
        });
      }
    },
    redo() {
      setAttemptId('');
      setFresh(newRun());
    },
    run,
  };
}

/** A signed-in try at a shared quiz: recorded on the account, but held only
 * by the page, so opening the page reads nothing (a shared page makes one
 * request, the Worker's). Each check posts to the quiz's check route,
 * continuing the attempt the page's first check started. */
export function useSharedAccountRun(
  quizId: string,
  beforeCheck: () => Promise<unknown>
): QuizRunControl {
  const [attemptId, setAttemptId] = useState('');
  const [run, setRun] = useState<LocalRun>(newLocalRun);
  return {
    async check(questionId, answers) {
      await beforeCheck();
      const attempt = await api.post<AttemptDetail>(
        `/quizzes/${quizId}/check`,
        {
          answers,
          attemptId: attemptId || undefined,
          questionId,
          startedAt: run.startedAt,
        } satisfies CheckQuizQuestionReq
      );
      setAttemptId(attempt.id);
      setRun((current) => ({
        ...current,
        answers: { ...current.answers, ...answers },
        checked: attempt.questions,
        takenAt: attempt.takenAt ?? new Date().toISOString(),
      }));
    },
    redo() {
      setAttemptId('');
      setRun(newLocalRun());
    },
    run,
  };
}

/** A try that lives only on the page: a quiz embedded in a note, in the app
 * (graded and recording nothing) or on a shared note. */
export function useMemoryRun(
  grade: (questionId: string, answers: Answers) => Promise<GradedQuestion>
): QuizRunControl {
  const [run, setRun] = useState(newRun);
  return {
    async check(questionId, answers) {
      const graded = await grade(questionId, answers);
      setRun((current) => addChecked(current, graded.question, answers));
    },
    redo: () => setRun(newRun()),
    run,
  };
}

/**
 * A signed-out try at a shared quiz, kept in this browser: its id in
 * localStorage, the attempt itself with the visitor's past attempts in
 * IndexedDB (`past`), saved on every check. The page shows the run it holds,
 * so a failed save loses nothing on the page; `past` only restores a kept try
 * when the page opens.
 */
export function useLocalRun(
  quiz: { id: string; name: string; questions: (Question | LearnerQuestion)[] },
  past: LocalQuizAttempt[],
  grade: (questionId: string, answers: Answers) => Promise<GradedQuestion>,
  onSaved: (attempt: LocalQuizAttempt) => void,
  onSaveFailed: () => void
): QuizRunControl {
  const [attemptId, setAttemptId] = useLocalPref(
    PREF_KEYS.quizAttempt('local', quiz.id),
    '',
    isString
  );
  const [fresh] = useState(newLocalRun);
  // The run once this page has checked or reset; until then the kept one.
  const [current, setCurrent] = useState<LocalRun | null>(null);
  const stored = past.find((attempt) => attempt.id === attemptId);
  const run: LocalRun =
    current ??
    (stored && {
      answers: stored.answers,
      checked: stored.questions,
      startedAt: stored.startedAt,
      takenAt: stored.takenAt,
    }) ??
    fresh;
  return {
    async check(questionId, answers) {
      const graded = await grade(questionId, answers);
      const next = addChecked(run, graded.question, answers);
      const id = attemptId || crypto.randomUUID();
      if (id !== attemptId) setAttemptId(id);
      setCurrent(next);
      const { awarded, max } = runScore(quiz.questions, next.checked);
      const attempt: LocalQuizAttempt = {
        answers: next.answers,
        correct: awarded,
        id,
        questions: next.checked,
        quizId: quiz.id,
        quizName: quiz.name,
        startedAt: next.startedAt,
        takenAt: next.takenAt,
        total: max,
      };
      saveLocalQuizAttempt(attempt).then(() => onSaved(attempt), onSaveFailed);
    },
    redo() {
      setAttemptId('');
      setCurrent(newLocalRun());
    },
    run,
  };
}
