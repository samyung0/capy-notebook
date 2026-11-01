import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import { TOUR_SAMPLE_SESSION } from './tourSamples';

// The tour's examples on the starter workspace (no chats, nothing to review,
// no past review): shown only while the tour runs there and the real data is
// empty, display-only.

const page = vi.hoisted(() => ({
  chats: [] as { id: string; title: string }[],
  sessionId: '',
  tour: null as { workspaceId: string } | null,
}));
const useReviewResult = vi.hoisted(() =>
  vi.fn(() => ({
    data: undefined,
    fetchStatus: 'idle',
    isError: false,
    isLoading: false,
  }))
);

vi.mock('./tourStore', () => ({ useRunningTour: () => page.tour }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  linkOptions: <T,>(options: T) => options,
  useCanGoBack: () => false,
  useNavigate: () => vi.fn(),
  useParams: () => ({ sessionId: page.sessionId, workspaceId: 'ws' }),
  useRouter: () => null,
  useSearch: () => ({ group: 'workspace' }),
}));
vi.mock('@/api/hooks', () => ({
  invalidateStudy: vi.fn(),
  useConversations: () => ({ data: page.chats }),
  useDeleteConversation: () => ({ mutate: vi.fn() }),
  useFinishReviewSession: () => ({ mutate: vi.fn() }),
  useRateReviewItem: () => ({ mutateAsync: vi.fn() }),
  useResumeReviewSession: () => ({ data: undefined }),
  useReviewOverview: () => ({ data: undefined }),
  useReviewResult,
  useUpdateConversation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useWorkspace: () => ({ data: undefined }),
  // The starter workspace's review: its embedded items record no study.
  useWorkspaceReview: () => ({
    data: { done: [], group: 'workspace', items: [], removedAssetIds: [] },
    isError: false,
    isFetching: false,
  }),
}));
vi.mock('@/components/app/layout', () => ({
  PagePanel: ({
    children,
    header,
  }: {
    children: ReactNode;
    header?: ReactNode;
  }) => (
    <>
      {header}
      {children}
    </>
  ),
}));

const { ConversationList } = await import(
  '@/features/workspace/chat/ConversationList'
);
const { default: ReviewSession } = await import('@/routes/ReviewSession');
const { default: ReviewResult } = await import('@/routes/ReviewResult');

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
  );
const chats = () =>
  render(
    <ConversationList
      activeId={null}
      onOpen={vi.fn()}
      onRemoved={vi.fn()}
      workspaceId="ws"
    />
  );

afterEach(() => {
  page.chats = [];
  page.tour = null;
  useReviewResult.mockClear();
});

it('shows example chats while the tour runs in a workspace without chats', () => {
  expect(chats()).toContain(m.chat_no_conversations());

  page.tour = { workspaceId: 'ws' };
  const html = chats();
  expect(html).toContain(m.tour_example());
  expect(html).toContain(m.tour_sample_chat_summary());
  expect(html).not.toContain(m.chat_no_conversations());

  page.chats = [{ id: 'c1', title: 'Cells' }];
  expect(chats()).not.toContain(m.tour_sample_chat_summary());

  page.chats = [];
  page.tour = { workspaceId: 'other' };
  expect(chats()).not.toContain(m.tour_sample_chat_summary());
});

it('shows an example card to rate while the tour runs and nothing is due', () => {
  expect(render(<ReviewSession />)).toContain(m.review_nothing());

  page.tour = { workspaceId: 'ws' };
  const html = render(<ReviewSession />);
  expect(html).toContain(m.tour_example());
  expect(html).toContain(m.tour_sample_card_retrieval_back());
  expect(html).toContain(m.srs_good());
  expect(html).not.toContain(m.review_nothing());
});

it("shows the tour's sample result without fetching it", () => {
  page.sessionId = TOUR_SAMPLE_SESSION;
  page.tour = { workspaceId: 'ws' };
  const html = render(<ReviewResult />);
  expect(html).toContain(m.tour_sample_chapter());
  expect(html).toContain(m.tour_sample_question_spacing());
  expect(useReviewResult).toHaveBeenCalledWith(
    TOUR_SAMPLE_SESSION,
    expect.objectContaining({ enabled: false })
  );

  page.tour = null;
  expect(render(<ReviewResult />)).toContain(m.review_result_unavailable());
});
