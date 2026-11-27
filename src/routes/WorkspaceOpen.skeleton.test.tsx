import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { m } from '@/i18n';

const page = vi.hoisted(() => ({
  /** Media queries that match: the rail's from 768px, the panels' from 1260px. */
  wide: [] as string[],
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  Navigate: () => null,
  Outlet: () => null,
  useChildMatches: ({ select }: { select: (matches: never[]) => unknown }) =>
    select([]),
  useNavigate: () => vi.fn(),
  useParams: () => ({ workspaceId: 'ws' }),
  useRouter: () => ({ latestLocation: { search: {} } }),
  useSearch: () => ({}),
}));
vi.mock('@/lib/useMediaQuery', () => ({
  useMediaQuery: (query: string) => page.wide.includes(query),
}));
vi.mock('@/api/hooks', () => ({
  useAddTopic: () => ({}),
  useFile: () => ({}),
  useFiles: () => ({}),
  useMaterials: () => ({}),
  useTopics: () => ({}),
  useUpdateTopic: () => ({}),
  useVisitWorkspace: () => vi.fn(),
  // The workspace's read on its way.
  useWorkspace: () => ({ fetchStatus: 'fetching', isLoading: true }),
  workspaceQuery: (id: string) => ({ enabled: false, queryKey: ['ws', id] }),
}));

const { default: WorkspaceOpenPage } = await import('./WorkspaceOpen');

const render = () =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceOpenPage />
    </QueryClientProvider>
  );

// Q906: the frame draws at once instead of the "Loading workspace" spinner,
// with nothing a role decides (sections, Settings, Upload) before the read.
it("draws the workspace's frame with skeletons while its read is pending", () => {
  page.wide = ['(min-width: 768px)', '(min-width: 1260px)'];
  const html = render();
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain(m.workspace_rail_label());
  expect(html).toContain(m.nav_workspaces());
  expect(html).toContain(m.dashboard_recent_files());
  expect(html).not.toContain(m.workspace_rail_settings());
  expect(html).not.toContain(m.workspace_tab_study());
  expect(html).not.toContain(m.action_upload());
});

it('gives a phone its header with the way back instead of the rail', () => {
  page.wide = [];
  const html = render();
  expect(html).not.toContain(m.workspace_rail_label());
  expect(html).toContain(m.workspace_back_to());
  expect(html).toContain(m.dashboard_recent_files());
});
