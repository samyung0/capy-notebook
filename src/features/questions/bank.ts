import { queryOptions } from '@tanstack/react-query';
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
export function uploadBankAsset(file: File): Promise<{ url: string }> {
  const body = new FormData();
  body.append('file', file);
  return api.upload('/bank/assets', body);
}
