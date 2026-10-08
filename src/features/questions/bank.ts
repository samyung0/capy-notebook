import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from '@tanstack/react-query';
import { api } from '@/api/client';
import type {
  BankCopyReq,
  BankCopyResult,
  BankProgress,
  BankTopicMarks,
  CheckBankQuestionReq,
  ExamCover,
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
export type BankExam = {
  id: string;
  label: string;
  /** The full name, shown and searched in the exam switcher. */
  fullLabel: string;
  cover: ExamCover;
  subjects: BankSubject[];
};
export type BankSyllabus = {
  exams: BankExam[];
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
/** The topic list's filters; empty values keep every question. */
export type BankListFilters = {
  types: string[];
  statuses: string[];
  search: string;
  unreviewed: boolean;
};
/** One page of a topic's rows, filtered on the server in position order. */
export type BankPage = {
  items: BankRow[];
  nextCursor?: string;
  prevCursor?: string;
  /** The answer types present in the whole topic. */
  answerTypes: string[];
};
/** Every list query of a topic, whatever its filters. */
export const bankTopicKey = (topicId: string) => ['bank', 'topics', topicId];
/**
 * The topic's rows a page at a time, loading at either end. `around` opens on
 * the page holding that question (the top when it is not listed).
 */
export const bankListQuery = (
  topicId: string,
  filters: BankListFilters,
  around: string
) =>
  infiniteQueryOptions({
    enabled: Boolean(topicId),
    getNextPageParam: (last: BankPage) => last.nextCursor,
    getPreviousPageParam: (first: BankPage) => first.prevCursor,
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (filters.types.length) params.set('type', filters.types.join(','));
      if (filters.statuses.length)
        params.set('status', filters.statuses.join(','));
      if (filters.search) params.set('q', filters.search);
      if (filters.unreviewed) params.set('unreviewed', 'true');
      if (pageParam) params.set('cursor', pageParam);
      else if (around) params.set('around', around);
      return api.get<BankPage>(
        '/bank/topics/' +
          encodeURIComponent(topicId) +
          '/questions?' +
          params.toString()
      );
    },
    queryKey: [...bankTopicKey(topicId), filters, around],
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
/** The /qb landing: topics with an answered question, latest first. */
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

export function uploadBankAsset(file: File): Promise<{ url: string }> {
  const body = new FormData();
  body.append('file', file);
  return api.upload('/bank/assets', body);
}
