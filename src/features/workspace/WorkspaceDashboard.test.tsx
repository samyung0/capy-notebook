import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Assignment, WorkspaceDashboard as Dashboard } from '@/api/types';
import { TodoSection } from '@/features/study/assignments/TodoSection';
import { m } from '@/i18n';
import { shortTime, WorkspaceDashboard } from './WorkspaceDashboard';

const page = vi.hoisted(() => ({
  account: undefined as Record<string, unknown> | undefined,
  assignments: [] as Assignment[],
  data: undefined as Dashboard | undefined,
  kind: 'personal' as 'class' | 'personal',
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    search,
    to,
  }: {
    children: ReactNode;
    search: Record<string, string>;
    to?: string;
  }) => (
    <a
      href={`${(to ?? '').replace('/workspaces/$workspaceId', '')}?${new URLSearchParams(search)}`}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/api/hooks', () => ({
  useContinue: () => ({ data: [] }),
  useHideTodoDone: () => ({ mutateAsync: vi.fn() }),
  useMe: () => ({ data: { account: page.account } }),
  useStartAssignment: () => ({ mutate: vi.fn() }),
  // The Dashboard's To do reads To do's own list.
  useTodo: () => ({
    data: { workspaces: [{ items: page.assignments, workspaceId: 'ws' }] },
  }),
  useTodoTick: () => ({ mutateAsync: vi.fn() }),
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
          iconId: 'ws-icon',
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
  expect(render()).toContain(m.content_hidden());
});

// Epo 2026-11-10: a class's To do stays, and the empty state stands where
// Recent files would.
it('shows an empty class its To do, then its art, a short title and one button', () => {
  page.data = { activity: [], members: 1, ownerName: 'Ms Wong' };
  page.kind = 'class';
  const html = render();
  expect(html).toContain('Biology 101');
  expect(html).toContain(m.todo_empty());
  expect(html.indexOf(m.workspace_empty_title())).toBeGreaterThan(
    html.indexOf(m.todo_empty())
  );
  expect(html).toContain(m.action_add_file());
  expect(html).not.toContain(m.action_upload());
  expect(html).not.toContain(m.dashboard_make_quiz());
  expect(html).not.toContain(m.dashboard_activity());
  expect(html).not.toContain(m.dashboard_recent_files());
  // Those who may not add get no button.
  expect(render(false)).not.toContain(m.action_add_file());
  page.kind = 'personal';
});

it("lists a class's To do: answers to approve for its owner, Nothing to do when empty", () => {
  page.data = { activity: [], members: 7, ownerName: 'Ms Wong' };
  page.kind = 'class';
  page.assignments = [];
  expect(render()).toContain(m.todo_empty());
  page.assignments = [
    {
      allowUploads: false,
      attempts: 1,
      closed: false,
      draft: false,
      files: [],
      gradesHidden: false,
      id: 'as_1',
      kind: 'marked',
      latePenaltyPct: 0,
      manage: {
        approvalsCheckedOff: false,
        assignAll: true,
        assigned: 6,
        assignees: [],
        done: 5,
        graded: 0,
        marking: 'ai_approve',
        notGraded: 0,
        showAnswers: 'submitted',
        showGrades: 'automatic',
        shuffle: false,
        toApprove: 5,
      },
      marks: 40,
      noLate: false,
      paperFile: false,
      postedAt: '2026-11-03T08:00:00Z',
      postedBy: 'Ms Wong',
      questions: 12,
      title: 'Past paper',
      topicIds: [],
      uploadOnly: false,
      workspaceId: 'ws',
    } as Assignment,
  ];
  const html = render();
  expect(html).toContain(m.dashboard_todo());
  expect(html).toContain('Past paper');
  // The To do page's table: the row opens its details, with Approve marks.
  expect(html).toContain(m.todo_answers_waiting({ count: 5 }));
  page.assignments = [];
  page.kind = 'personal';
});

// Epo 2026-11-21: nothing is given out in a personal workspace.
it('has no To do in a personal workspace', () => {
  page.data = { activity: [], members: 1, ownerName: 'Kate' };
  expect(render()).not.toContain(m.dashboard_todo());
});

it('keeps an empty To do, saying Nothing to do', () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TodoSection
        manages={false}
        workspace={{ iconId: 'i', id: 'ws', name: 'Notes' }}
      />
    </QueryClientProvider>
  );
  expect(html).toContain(m.todo_empty());
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
  expect(render()).toContain('href="/assignments?assignment=as_1"');
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
