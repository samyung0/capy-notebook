import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { Provenance } from '@/api/types';
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
export function uploadBankAsset(file: File): Promise<{ url: string }> {
  const body = new FormData();
  body.append('file', file);
  return api.upload('/bank/assets', body);
}
