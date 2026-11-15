import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { Question } from '@/features/questions/types';
import { api } from './client';
import type { ItemBank, ItemBankPage, ItemBankQuestion } from './types';

/** Item banks (todo-graded-quizzes.md): the caller's own bank is `me`; a class
 * workspace's is named by the workspace's id, and only its owner and editors
 * reach it. A question goes in and comes out as a copy. */
export const PERSONAL_BANK = 'me';

export interface ItemBankFilter {
  /** Words the question's text or answers hold. */
  q?: string;
  /** Questions holding any of these tags. */
  tags?: string[];
  /** A class bank's questions whose topic is one of these. */
  topics?: string[];
}

export const itemBankKeys = {
  all: ['item-banks'] as const,
  /** The banks the caller may use from a workspace, or with none their own. */
  banks: (workspaceId?: string) =>
    ['item-banks', 'list', workspaceId ?? ''] as const,
  questions: (bank: string, filter: ItemBankFilter) =>
    [
      'item-banks',
      bank,
      'questions',
      filter.q ?? '',
      filter.tags ?? [],
      filter.topics ?? [],
    ] as const,
  tags: (bank: string) => ['item-banks', bank, 'tags'] as const,
};

const bankPath = (bank: string) => `/item-banks/${encodeURIComponent(bank)}`;

/** The banks the caller may use: a class's when they are its staff, then
 * their own (always last). */
export const itemBanksQuery = (workspaceId?: string) =>
  queryOptions({
    queryFn: ({ signal }) =>
      api
        .get<{ items: ItemBank[] }>(
          `/item-banks${workspaceId ? `?${new URLSearchParams({ workspaceId })}` : ''}`,
          { signal }
        )
        .then((body) => body.items),
    queryKey: itemBankKeys.banks(workspaceId),
  });

export const useItemBanks = (workspaceId?: string, enabled = true) =>
  useQuery({
    ...itemBanksQuery(workspaceId),
    enabled,
    meta: { errorBoundary: false },
  });

/** A bank's questions, newest first, a page at a time; `total` counts every
 * match. */
export const itemBankQuestionsQuery = (
  bank: string,
  filter: ItemBankFilter = {}
) =>
  infiniteQueryOptions({
    getNextPageParam: (last: ItemBankPage) => last.nextCursor || undefined,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const search = new URLSearchParams();
      if (filter.q) search.set('q', filter.q);
      if (filter.tags?.length) search.set('tags', filter.tags.join(','));
      if (filter.topics?.length) search.set('topics', filter.topics.join(','));
      if (pageParam) search.set('cursor', pageParam);
      const qs = search.toString();
      return api.get<ItemBankPage>(
        `${bankPath(bank)}/questions${qs ? `?${qs}` : ''}`,
        { signal }
      );
    },
    queryKey: itemBankKeys.questions(bank, filter),
  });

export const useItemBankQuestions = (bank: string, filter: ItemBankFilter) =>
  useInfiniteQuery({
    ...itemBankQuestionsQuery(bank, filter),
    meta: { errorBoundary: false },
  });

/** Every tag the bank's questions hold, for its Tags filter and tag input. */
export const useItemBankTags = (bank: string) =>
  useQuery({
    meta: { errorBoundary: false },
    queryFn: ({ signal }) =>
      api
        .get<{ tags: string[] }>(`${bankPath(bank)}/tags`, { signal })
        .then((body) => body.tags),
    queryKey: itemBankKeys.tags(bank),
  });

/** A question copied into a bank (New question, Add to bank), or with `id`
 * an edit of one. */
export interface SaveBankQuestion {
  bank: string;
  id?: string;
  question: Question;
  tags: string[];
}

export const saveItemBankQuestion = ({
  bank,
  id,
  question,
  tags,
}: SaveBankQuestion) =>
  id
    ? api.put<ItemBankQuestion>(
        `${bankPath(bank)}/questions/${encodeURIComponent(id)}`,
        { question, tags }
      )
    : api.post<ItemBankQuestion>(`${bankPath(bank)}/questions`, {
        question,
        tags,
      });

export function useSaveItemBankQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveItemBankQuestion,
    onSuccess: () => qc.invalidateQueries({ queryKey: itemBankKeys.all }),
  });
}

export function useDeleteItemBankQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bank, id }: { bank: string; id: string }) =>
      api.del<void>(`${bankPath(bank)}/questions/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: itemBankKeys.all }),
  });
}
