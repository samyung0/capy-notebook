import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '@/api/client';
import type {
  BankAnswerReq,
  BankCopyReq,
  BankCopyResult,
  BankProgress,
  BankRevealReq,
  BankTopicMarks,
  Provenance,
} from '@/api/types';
import { type Answers, scoreQuestion } from '@/features/quizzes/grade';
import type { LearnerQuestion, Question } from './types';

export type BankTopic = {
  id: string;
  label: string;
  total: number;
  reviewed: number;
};
export type BankSubject = { id: string; label: string; topics: BankTopic[] };
export type BankSyllabus = {
  exams: { id: string; label: string; subjects: BankSubject[] }[];
  editor: boolean;
  assetsUrl: string;
};
export type BankRow = {
  id: string;
  position: number;
  preview: string;
  marks: number;
  hasFigure: boolean;
  hasTable: boolean;
  /** The distinct answer types of its parts, in part order. */
  answerTypes: string[];
  reviewedAt: string | null;
  reviewerName: string;
};
export type BankDetail = {
  question: Question | LearnerQuestion;
  sources: unknown[];
  provenance?: Provenance;
  updatedAt: string;
  reviewedAt: string | null;
  reviewedBy: string;
  reviewerName: string;
  editor: boolean;
  topicId: string;
  position: number;
  examLabel: string;
  subjectLabel: string;
  topicLabel: string;
};
export const bankSyllabusQuery = () =>
  queryOptions({
    queryFn: () => api.get<BankSyllabus>('/bank/syllabus'),
    queryKey: ['bank', 'syllabus'],
    retry: false,
  });
export const bankQuestionsQuery = (topicId: string) =>
  queryOptions({
    enabled: Boolean(topicId),
    queryFn: () =>
      api.get<{ questions: BankRow[] }>(
        '/bank/topics/' + encodeURIComponent(topicId) + '/questions'
      ),
    queryKey: ['bank', 'topics', topicId],
    retry: false,
  });
export const bankQuestionQuery = (id: string) =>
  queryOptions({
    enabled: Boolean(id),
    queryFn: () =>
      api.get<BankDetail>('/bank/questions/' + encodeURIComponent(id)),
    queryKey: ['bank', 'questions', id],
    retry: false,
  });
/** The server's cap on ids per batch request. */
const BATCH_MAX = 50;
/**
 * Loads the questions among `ids` that are not cached yet (or were
 * invalidated) and stores each in its bankQuestionQuery entry, where the page
 * reads it; edits and reviews update those entries directly.
 */
export const bankBatchQuery = (client: QueryClient, ids: string[]) =>
  queryOptions({
    enabled: ids.length > 0,
    queryFn: async () => {
      const missing = ids.filter((id) => {
        const state = client.getQueryState(bankQuestionQuery(id).queryKey);
        return !state?.data || state.isInvalidated;
      });
      const pages: string[][] = [];
      for (let i = 0; i < missing.length; i += BATCH_MAX)
        pages.push(missing.slice(i, i + BATCH_MAX));
      const results = await Promise.all(
        pages.map((page) =>
          api.get<{ questions: BankDetail[] }>(
            '/bank/questions?ids=' + page.map(encodeURIComponent).join(',')
          )
        )
      );
      for (const { questions } of results)
        for (const detail of questions)
          client.setQueryData(
            bankQuestionQuery(detail.question.id).queryKey,
            detail
          );
      return missing.length;
    },
    queryKey: ['bank', 'batch', ...ids],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
/** The topic list's results: answered current questions' latest scores, 0 to 1. */
export const bankMarksQuery = (topicId: string) =>
  queryOptions({
    enabled: Boolean(topicId),
    queryFn: () =>
      api.get<BankTopicMarks>(
        '/bank/topics/' + encodeURIComponent(topicId) + '/marks'
      ),
    queryKey: ['bank', 'marks', topicId],
    retry: false,
  });
/** The /bank landing: topics with an answered question, latest first. */
export const bankProgressQuery = () =>
  queryOptions({
    queryFn: () => api.get<BankProgress>('/bank/progress'),
    queryKey: ['bank', 'progress'],
    retry: false,
  });
export const copyBankQuestions = (body: BankCopyReq) =>
  api.post<BankCopyResult>('/bank/copy', body);
/** Checking answers is what reveals a question's key, one question at a time. */
export const revealBankQuestion = (id: string, body: BankRevealReq) =>
  api.post<{ question: Question }>(
    '/bank/questions/' + encodeURIComponent(id) + '/reveal',
    body
  );
export const recordBankAnswer = (id: string, body: BankAnswerReq) =>
  api.post<void>(
    '/bank/questions/' + encodeURIComponent(id) + '/answers',
    body
  );

export const BANK_STATUSES = [
  'correct',
  'wrong',
  'partial',
  'notDone',
] as const;
export type BankStatus = (typeof BANK_STATUSES)[number];

/** Full marks is correct, none is wrong, anything between is partially wrong. */
export function bankStatus(score: number | undefined): BankStatus {
  if (score === undefined) return 'notDone';
  return score >= 1 ? 'correct' : score <= 0 ? 'wrong' : 'partial';
}

/** Rows with a part of one of `types` and a status among `statuses`; an
 * empty list keeps every row. */
export function filterBankRows<R extends Pick<BankRow, 'id' | 'answerTypes'>>(
  rows: R[],
  types: string[],
  statuses: string[],
  marks: Record<string, number>
): R[] {
  return rows.filter(
    (row) =>
      (!types.length || row.answerTypes.some((type) => types.includes(type))) &&
      (!statuses.length || statuses.includes(bankStatus(marks[row.id])))
  );
}

/** Pairs equal texts, each target used once: for every `from` index, its
 * index in `to` (-1 when missing). */
function textIndices(from: string[], to: string[]): number[] {
  const used = new Set<number>();
  return from.map((text) => {
    const index = to.findIndex((item, j) => item === text && !used.has(j));
    used.add(index);
    return index;
  });
}

/**
 * The revealed question and answers in terms the shared scorer reads.
 * Learners answered a view with matching options and ordering items shuffled
 * by the server: matching keeps the shown letters (its key follows them) and
 * ordering answers turn into stored positions, which are the key.
 */
export function alignReveal(
  shown: Question | LearnerQuestion,
  full: Question,
  answers: Answers
): { question: Question; answers: Answers } {
  const aligned: Answers = { ...answers };
  const parts = full.parts.map((part) => {
    const seen = shown.parts.find((item) => item.id === part.id)?.answer;
    const value = answers[part.id];
    if (part.answer.type === 'matching' && seen?.type === 'matching') {
      const toShown = textIndices(part.answer.options, seen.options);
      return {
        ...part,
        answer: {
          ...part.answer,
          options: seen.options,
          pairs: part.answer.pairs.map((pair) => ({
            ...pair,
            right: toShown[pair.right] ?? -1,
          })),
        },
      };
    }
    if (
      part.answer.type === 'ordering' &&
      seen?.type === 'ordering' &&
      Array.isArray(value)
    ) {
      const toStored = textIndices(seen.items, part.answer.items);
      aligned[part.id] = value.map((i) =>
        typeof i === 'number' ? (toStored[i] ?? -1) : -1
      );
    }
    return part;
  });
  return { answers: aligned, question: { ...full, parts } };
}

/** Awarded over available marks, the score the answers route records; null
 * when the question has open parts, which only Jev can grade. */
export function bankScore(question: Question, answers: Answers): number | null {
  if (question.parts.some((part) => part.answer.type === 'open')) return null;
  const { awarded, max } = scoreQuestion(question, answers);
  return max > 0 ? awarded / max : 0;
}

export function uploadBankAsset(file: File): Promise<{ url: string }> {
  const body = new FormData();
  body.append('file', file);
  return api.upload('/bank/assets', body);
}
