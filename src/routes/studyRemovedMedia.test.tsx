import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Question } from '@/features/questions/types';
import { getLocale, m } from '@/i18n';

// The locale resolves before a window exists, which would make paraglide keep
// it in localStorage; then linkedom's document goes in before
// react-dom/client loads, which reads it once.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

// Study screens show an image its uploader deleted as removed, from their own
// payload's removedAssetIds (Epo 2026-10-24, M16): a quiz attempt, flashcard
// study and a review session.

const question: Question = {
  id: 'q1',
  labels: 'letters',
  layout: 'paper',
  parts: [
    {
      answer: { correct: true, type: 'boolean' },
      blocks: [{ text: 'True?', type: 'text' }],
      id: 'q1:part:1',
      marks: 1,
      solution: [],
    },
  ],
  stem: [
    { height: 10, image: { assetId: 'asset_quiz' }, type: 'image', width: 10 },
  ],
};
const card = {
  back: 'Back',
  front: 'Front',
  id: 'c1',
  image: { assetId: 'asset_card' },
  materialId: 'set',
  revision: 1,
};

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  linkOptions: <T,>(options: T) => options,
  useCanGoBack: () => false,
  useNavigate: () => vi.fn(),
  useParams: () => ({
    flashcardSetId: 'set',
    quizId: 'quiz',
    workspaceId: 'ws',
  }),
  useRouter: () => null,
  useSearch: () => ({ group: 'workspace' }),
}));
const loaded = {
  fetchStatus: 'idle',
  isFetchedAfterMount: true,
  refetch: vi.fn(),
};
vi.mock('@/api/hooks', () => ({
  useCards: () => ({ data: [card], ...loaded }),
  useFinishReviewSession: () => ({ mutate: vi.fn() }),
  useFlashcardSet: () => ({
    data: {
      cardCount: 1,
      id: 'set',
      name: 'Cells',
      removedAssetIds: ['asset_card'],
      workspaceId: '',
    },
    ...loaded,
  }),
  useQuiz: () => ({
    data: {
      id: 'quiz',
      name: 'Cells',
      questions: [question],
      removedAssetIds: ['asset_quiz'],
      workspaceId: '',
    },
    ...loaded,
  }),
  useRateReviewItem: () => ({ mutateAsync: vi.fn() }),
  useResumeReviewSession: () => ({ data: undefined }),
  useReviewOverview: () => ({ data: undefined }),
  useSubmitAttempt: () => ({ mutateAsync: vi.fn() }),
  useWorkspace: () => ({ data: undefined }),
  useWorkspaceReview: () => ({
    data: {
      done: [],
      group: 'workspace',
      items: [
        {
          front: 'Front',
          image: { assetId: 'asset_review' },
          itemId: 'c1',
          kind: 'card',
          materialId: 'set',
          materialTitle: 'Cells',
        },
      ],
      removedAssetIds: ['asset_review'],
      total: 1,
    },
    isError: false,
    isFetching: false,
  }),
}));
vi.mock('@/components/app/layout', () => ({
  PageHeader: () => null,
  PagePanel: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/features/quizzes/liveQuizReads', () => ({
  useLiveQuizQuestions: (_id: string, questions: unknown) => questions,
}));
vi.mock('@/features/flashcards/liveReads', () => ({
  useLiveSetCards: (_id: string, cards: unknown) => cards,
}));
vi.mock('@/features/workspace/WorkspaceHealth', () => ({
  useAccountFrozen: () => false,
}));
vi.mock('@/features/study/useChapterNames', () => ({
  useChapterNames: () => () => undefined,
}));
const { default: QuizAttempt } = await import('./QuizAttempt');
const { default: FlashcardStudy } = await import('./FlashcardStudy');
const { default: ReviewSession } = await import('./ReviewSession');
const { ReviewResultBody } = await import('@/features/study/ReviewResult');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
  );

it('shows a removed image in a quiz attempt', () => {
  expect(render(<QuizAttempt />)).toContain(m.media_image_removed());
});

it('shows a removed card image in flashcard study', () => {
  expect(render(<FlashcardStudy />)).toContain(m.media_image_removed());
});

it('shows a removed card image in a review session', () => {
  expect(render(<ReviewSession />)).toContain(m.media_image_removed());
});

// A result's graded question keeps the plain empty box for a missing image,
// even inside a session that names it as removed (Q270).
it("keeps the plain box for a missing image in a review session's result", async () => {
  const { RemovedAssetsContext } = await import(
    '@/features/materials/MediaAssetView'
  );
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <RemovedAssetsContext.Provider value={{ ids: new Set(['asset_quiz']) }}>
        <ReviewResultBody
          onAgain={() => undefined}
          result={{
            better: 0,
            items: [
              {
                correct: 1,
                itemId: 'q1',
                kind: 'question',
                materialId: 'quiz',
                materialTitle: 'Cells',
                question,
                rating: 3,
                total: 1,
              },
            ],
            session: {
              answered: 1,
              group: 'workspace',
              iconId: '',
              id: 'rs',
              lastAnswerAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              total: 1,
              workspaceId: 'ws',
              workspaceName: 'Bio',
            },
          }}
        />
      </RemovedAssetsContext.Provider>
    )
  );
  await act(async () => {
    document
      .querySelector('li [aria-expanded]')
      ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  const text = document.getElementById('root')?.textContent;
  expect(text).toContain('True?');
  expect(text).not.toContain(m.media_image_removed());
  await act(async () => root.unmount());
});
