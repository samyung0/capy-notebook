import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type {
  Assignment,
  WorkspaceDashboard as Dashboard,
  Workspace,
} from '@/api/types';
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

// Epo 2026-11-10: To do stays, and the empty state stands where Recent files would.
it('shows an empty workspace its To do, then its art, a short title and one button', () => {
  page.data = { activity: [], members: 1, ownerName: 'Ms Wong' };
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
});

it("lists a class's To do: answers to approve for its owner, Nothing to do when empty", () => {
  page.data = { activity: [], members: 7, ownerName: 'Ms Wong' };
  page.kind = 'class';
  page.assignments = [];
  expect(render()).toContain(m.todo_empty());
  expect(render()).toContain('aria-haspopup="menu"');
  page.assignments = [
    {
      allowUploads: false,
      attempts: 1,
      closed: false,
      draft: false,
      drawingParts: false,
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
        marking: 'ai_approve',
        notGraded: 0,
        showAnswers: 'submitted',
        showGrades: 'automatic',
        shuffle: false,
        toApprove: 5,
      },
      marks: 40,
      noLate: false,
      own: false,
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
  // The To do page's table: the row opens its details, with Approve marks.
  expect(html).toContain(m.todo_answers_waiting({ count: 5 }));
  // Staff's New is the menu of Assignment and Graded quiz.
  expect(html).toContain('aria-haspopup="menu"');
  page.assignments = [];
  page.kind = 'personal';
});

it("lists a personal workspace's To do: the tasks its viewer set themself, under the New menu", () => {
  page.data = { activity: [], members: 1, ownerName: 'Kate' };
  page.assignments = [
    {
      allowUploads: false,
      attempts: 1,
      closed: false,
      draft: false,
      drawingParts: false,
      files: [],
      gradesHidden: false,
      id: 'as_2',
      kind: 'unmarked',
      latePenaltyPct: 0,
      marks: 0,
      mine: {
        attemptsUsed: 0,
        checkedOff: false,
        done: false,
        late: false,
        latePenaltyPct: 0,
        missing: false,
        waitingAnswers: 0,
        waitingMarks: 0,
      },
      noLate: false,
      own: true,
      postedAt: '2026-11-03T08:00:00Z',
      postedBy: 'Kate',
      questions: 0,
      title: 'Read chapter 4',
      topicIds: [],
      workspaceId: 'ws',
    } as Assignment,
  ];
  const html = render();
  expect(html).toContain('Read chapter 4');
  // Task or Graded quiz, from the New menu.
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).not.toContain(m.todo_new_task());
  page.assignments = [];
});

it('keeps an empty To do, with the button of whoever may add', () => {
  const section = (manages: boolean, role: string, kind = 'class') =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <TodoSection
          manages={manages}
          workspace={{
            iconId: 'i',
            id: 'ws',
            kind: kind as Workspace['kind'],
            name: 'Notes',
            role: role as Workspace['role'],
          }}
        />
      </QueryClientProvider>
    );
  expect(section(false, 'viewer')).toContain(m.todo_empty());
  expect(section(false, 'viewer')).toContain(m.todo_new_task());
  // Staff and a personal workspace get the New menu (Assignment or Task,
  // and Graded quiz).
  expect(section(true, 'owner')).toContain('aria-haspopup="menu"');
  expect(section(false, 'owner', 'personal')).toContain('aria-haspopup="menu"');
  // A visitor who is no member has nothing to add.
  expect(section(false, '')).toContain(m.todo_empty());
  expect(section(false, '')).not.toContain(m.todo_new_task());
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
