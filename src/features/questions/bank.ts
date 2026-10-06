import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '@/api/client';
import type {
  BankCopyReq,
  BankCopyResult,
  BankProgress,
  BankTopicMarks,
  CheckBankQuestionReq,
  GradedQuestion,
  Provenance,
} from '@/api/types';
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
/** View mode reads questions without their key, for editors too; Edit mode
 * reads the key, which only editors get. */
export type BankMode = 'view' | 'edit';
const bankQuestionPath = (id: string, mode: BankMode) =>
  '/bank/questions/' +
  encodeURIComponent(id) +
  (mode === 'edit' ? '/edit' : '');
export const bankQuestionQuery = (id: string, mode: BankMode) =>
  queryOptions({
    enabled: Boolean(id),
    queryFn: () => api.get<BankDetail>(bankQuestionPath(id, mode)),
    queryKey: ['bank', 'questions', id, mode],
    retry: false,
  });
/** The server's cap on ids per batch request. */
const BATCH_MAX = 50;
/**
 * Loads the questions among `ids` that are not cached yet (or were
 * invalidated) and stores each in its bankQuestionQuery entry, where the page
 * reads it; edits and reviews update those entries directly.
 */
export const bankBatchQuery = (
  client: QueryClient,
  ids: string[],
  mode: BankMode
) =>
  queryOptions({
    enabled: ids.length > 0,
    queryFn: async () => {
      const missing = ids.filter((id) => {
        const state = client.getQueryState(
          bankQuestionQuery(id, mode).queryKey
        );
        return !state?.data || state.isInvalidated;
      });
      // The batch route is View mode's; Edit mode reads each question's key.
      const details =
        mode === 'edit'
          ? await Promise.all(
              missing.map((id) =>
                api.get<BankDetail>(bankQuestionPath(id, mode))
              )
            )
          : await batchDetails(missing);
      for (const detail of details)
        client.setQueryData(
          bankQuestionQuery(detail.question.id, mode).queryKey,
          detail
        );
      return missing.length;
    },
    queryKey: ['bank', 'batch', mode, ...ids],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
async function batchDetails(ids: string[]): Promise<BankDetail[]> {
  const pages: string[][] = [];
  for (let i = 0; i < ids.length; i += BATCH_MAX)
    pages.push(ids.slice(i, i + BATCH_MAX));
  const results = await Promise.all(
    pages.map((page) =>
      api.get<{ questions: BankDetail[] }>(
        '/bank/questions?ids=' + page.map(encodeURIComponent).join(',')
      )
    )
  );
  return results.flatMap(({ questions }) => questions);
}
/** An editor's save or review returns the question with its key: it replaces
 * the Edit mode entry, and View mode reloads its answer-free copy. */
export function storeBankEdit(client: QueryClient, detail: BankDetail) {
  const id = detail.question.id;
  client.setQueryData(bankQuestionQuery(id, 'edit').queryKey, detail);
  void client.invalidateQueries({
    queryKey: bankQuestionQuery(id, 'view').queryKey,
    refetchType: 'none',
  });
  void client.invalidateQueries({ queryKey: ['bank', 'batch', 'view'] });
}
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
/** Grades the answers on the server, which records the result, and returns
 * the question with its key: checking is what reveals it, one at a time. */
export const checkBankQuestion = (id: string, body: CheckBankQuestionReq) =>
  api.post<GradedQuestion>(
    '/bank/questions/' + encodeURIComponent(id) + '/check',
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

export function uploadBankAsset(file: File): Promise<{ url: string }> {
  const body = new FormData();
  body.append('file', file);
  return api.upload('/bank/assets', body);
}
