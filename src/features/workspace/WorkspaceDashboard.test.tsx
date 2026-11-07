import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type {
  Assignment,
  WorkspaceDashboard as Dashboard,
  ReviewSuggestion,
} from '@/api/types';
import { m } from '@/i18n';
import { shortTime, WorkspaceDashboard } from './WorkspaceDashboard';

const page = vi.hoisted(() => ({
  account: undefined as Record<string, unknown> | undefined,
  assignments: [] as Assignment[],
  data: undefined as Dashboard | undefined,
  kind: 'personal' as 'class' | 'personal',
  quizzes: [] as { id: string }[],
  suggestions: [] as ReviewSuggestion[],
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    search,
  }: {
    children: ReactNode;
    search: Record<string, string>;
  }) => <a href={`?${new URLSearchParams(search)}`}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock('@/api/hooks', () => ({
  useAssignments: () => ({ data: { items: page.assignments } }),
  useMe: () => ({ data: { account: page.account } }),
  usePractice: (_id: string, { enabled }: { enabled: boolean }) => ({
    data: enabled
      ? { quizzes: page.quizzes, suggestions: page.suggestions }
      : undefined,
  }),
  useSetAssignmentDone: () => ({ mutate: vi.fn() }),
  useStartAssignment: () => ({ mutate: vi.fn() }),
  useWorkspaceDashboard: () => ({ data: page.data }),
  useWorkspaceRecent: () => ({ data: { files: [], materials: [] } }),
}));

const render = (canEdit = true) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceDashboard
        onMakeQuiz={() => undefined}
        onUpload={() => undefined}
        workspace={{
          capabilities: { canEdit } as never,
          id: 'ws',
          kind: page.kind,
          name: 'Biology 101',
          role: 'owner',
        }}
      />
    </QueryClientProvider>
  );

// Epo 2026-11-05, Q631: Home's status reaches a workspace that opens on this page.
it('shows the viewer account status as a small banner below the title', () => {
  page.account = {
    state: 'over_quota_frozen',
    storageLimitBytes: 100_000_000,
    storageUsage: 'full',
    storageUsedBytes: 96_000_000,
  };
  const html = render();
  expect(html).toContain(m.account_banner_frozen_title());
  expect(html.indexOf('account-status-banner')).toBeGreaterThan(
    html.indexOf('Biology 101')
  );
  page.account = undefined;
  expect(render()).not.toContain('account-status-banner');
});

it('opens each activity row on its file or material', () => {
  page.data = {
    activity: [
      {
        actorName: 'Cara',
        at: '2026-11-04T08:00:00Z',
        fileId: 'f_1',
        kind: 'uploaded',
        title: 'Week 2.pptx',
      },
      {
        at: '2026-11-03T08:00:00Z',
        kind: 'agent',
        materialId: 'm_1',
        title: 'Cell cards',
      },
    ],
    members: 7,
    ownerName: 'Ms Wong',
  };
  const html = render();
  expect(html).toContain('href="?file=f_1"');
  expect(html).toContain('href="?material=m_1"');
});

it('marks a hidden item on its activity row', () => {
  page.data = {
    activity: [
      {
        actorName: 'Cara',
        at: '2026-11-04T08:00:00Z',
        fileId: 'f_1',
        hidden: true,
        kind: 'uploaded',
        title: 'Answers.pdf',
      },
    ],
    members: 7,
    ownerName: 'Ms Wong',
  };
  expect(render()).toContain(m.content_hidden_from_members());
});

it('shows an empty workspace its art, a short title and one button', () => {
  page.data = { activity: [], members: 1, ownerName: 'Ms Wong' };
  const html = render();
  expect(html).toContain('Biology 101');
  expect(html).toContain(m.workspace_empty_title());
  expect(html).toContain(m.action_add_file());
  expect(html).not.toContain(m.action_upload());
  expect(html).not.toContain(m.dashboard_make_quiz());
  expect(html).not.toContain(m.dashboard_activity());
  expect(html).not.toContain(m.dashboard_recent_files());
  // Those who may not add get no button.
  expect(render(false)).not.toContain(m.action_add_file());
});

it('shows What to practise next to whoever practises, not to a class owner', () => {
  page.data = { activity: [], members: 1, ownerName: 'Ms Wong' };
  page.suggestions = [
    {
      evidence: {
        forgotten: 2,
        lastPractisedAt: '2026-11-01T10:00:00Z',
        missed: 3,
        repeated: 0,
        young: 3,
      },
      group: 'topic',
      iconId: '',
      items: 3,
      mode: 'tricky',
      topicId: 't1',
      topicName: 'Osmosis',
      workspaceId: 'ws',
      workspaceName: 'Biology 101',
    },
  ];
  page.kind = 'personal';
  expect(render()).toContain(m.dashboard_practise_next());
  expect(render()).not.toContain(m.dashboard_workspace_review());
  page.quizzes = [{ id: 'q_1' }];
  expect(render()).toContain(m.dashboard_workspace_review());
  page.kind = 'class';
  expect(render()).not.toContain(m.dashboard_practise_next());
  page.quizzes = [];
  page.suggestions = [];
  page.kind = 'personal';
});

it("lists a class's To do: answers to approve for its owner, nothing when empty", () => {
  page.data = { activity: [], members: 7, ownerName: 'Ms Wong' };
  page.kind = 'class';
  page.assignments = [];
  expect(render()).not.toContain(m.dashboard_todo());
  page.assignments = [
    {
      attempts: 1,
      closed: false,
      draft: false,
      files: [],
      id: 'as_1',
      kind: 'marked',
      latePenaltyPct: 0,
      manage: {
        assignAll: true,
        assigned: 6,
        assignees: [],
        done: 5,
        marking: 'ai_approve',
        showAnswers: true,
        shuffle: false,
        toApprove: 5,
      },
      marks: 40,
      noLate: false,
      postedAt: '2026-11-03T08:00:00Z',
      postedBy: 'Ms Wong',
      questions: 12,
      title: 'Past paper',
      topicIds: [],
      workspaceId: 'ws',
    } as Assignment,
  ];
  const html = render();
  expect(html).toContain(m.dashboard_todo());
  expect(html).toContain('Past paper');
  expect(html).toContain(m.dashboard_waiting({ count: 5 }));
  expect(html).toContain('tab=approve');
  page.assignments = [];
  page.kind = 'personal';
});

it('opens an assigned row on its assignment', () => {
  page.data = {
    activity: [
      {
        actorName: 'Ms Wong',
        assignmentId: 'as_1',
        at: '2026-11-04T08:00:00Z',
        kind: 'assigned',
        title: 'Past paper',
      },
    ],
    members: 7,
    ownerName: 'Ms Wong',
  };
  expect(render()).toContain('href="?assignment=as_1&amp;study=assignments"');
});

it('writes times as the boards do', () => {
  const now = new Date(2026, 10, 4, 12).getTime();
  expect(shortTime(new Date(2026, 10, 4, 10).toISOString(), now)).toBe(
    m.dashboard_hours({ count: 2 })
  );
  expect(shortTime(new Date(2026, 10, 2, 10).toISOString(), now)).toBe(
    new Intl.DateTimeFormat('en', { weekday: 'short' }).format(
      new Date(2026, 10, 2)
    )
  );
});
