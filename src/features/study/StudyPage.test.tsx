import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import { StudyPage } from './StudyPage';

const study = vi.hoisted(() => ({
  enabled: true,
  quickReview: [] as Record<string, unknown>[],
  unfinished: undefined as
    | { answered: number; id: string; lastAnswerAt: string; total: number }
    | undefined,
}));

// A workspace with nothing in it yet (the starter workspace).
const content = vi.hoisted(() => ({ empty: false }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    params,
    to,
  }: {
    children: React.ReactNode;
    className?: string;
    params?: Record<string, string>;
    to: string;
  }) => (
    <a
      className={className}
      href={to.replace(/\$(\w+)/g, (_, key) => params?.[key] ?? '')}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useRouter: () => null,
}));

const attempt = (id: string, kind: 'quiz' | 'flashcards', takenAt: string) => ({
  chapters: [],
  correct: 3,
  id,
  kind,
  materialId: kind === 'quiz' ? 'qz' : 'set',
  pct: 75,
  quizName: '',
  startedAt: null,
  takenAt,
  total: 4,
  workspaceId: 'ws',
  workspaceName: 'Bio',
});

vi.mock('@/api/hooks', () => ({
  stepKey: (st: { kind: string; targetId: string; workspaceId: string }) =>
    `${st.kind}:${st.workspaceId}:${st.targetId}`,
  useChapters: () => ({ data: [] }),
  useCreateStudyPlan: () => ({ mutateAsync: vi.fn() }),
  useDeleteStudyPlan: () => ({ mutate: vi.fn() }),
  useFiles: () => ({
    data: content.empty
      ? []
      : [
          {
            addedAt: '',
            chapterId: null,
            id: 'f1',
            kind: 'pdf',
            name: 'Cells.pdf',
            position: 0,
          },
        ],
  }),
  useMaterials: () => ({
    data: content.empty
      ? []
      : [
          {
            chapterId: null,
            createdAt: '',
            id: 'qz',
            position: 1,
            title: 'Quiz',
            type: 'quiz',
          },
          {
            chapterId: null,
            createdAt: '',
            id: 'set',
            position: 2,
            title: 'Cards',
            type: 'flashcards',
          },
        ],
  }),
  usePlanStudy: (_ws: string, planId?: string) => ({
    data: planId
      ? {
          enabled: true,
          items: [],
          quickReview: [],
          recentAttempts: [],
          reviewable: 2,
        }
      : undefined,
  }),
  useRateReviewItem: () => ({ mutateAsync: vi.fn() }),
  useResetWorkspaceStudy: () => ({ mutate: vi.fn() }),
  useSetStudyItem: () => ({ mutate: vi.fn() }),
  useUpdateStudyPlan: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useWorkspace: () => ({ data: undefined }),
  useWorkspaceAttempts: () => ({
    data: {
      items: [
        {
          count: 2,
          materialId: 'qz',
          recent: [
            attempt('at_2', 'quiz', '2026-10-16T10:00:00Z'),
            attempt('at_1', 'quiz', '2026-10-11T10:00:00Z'),
          ],
          size: 10,
        },
        {
          count: 1,
          materialId: 'set',
          recent: [attempt('fa_1', 'flashcards', '2026-10-13T10:00:00Z')],
          size: 18,
        },
      ],
    },
  }),
  useWorkspacePlans: () => ({
    data: {
      plans: [
        {
          createdAt: '',
          id: 'p1',
          name: 'Winter exams',
          steps: [
            {
              kind: 'file',
              locked: false,
              targetId: 'f1',
              title: 'Cells.pdf',
              workspaceId: 'ws',
            },
            {
              kind: 'material',
              locked: false,
              targetId: 'qz',
              title: 'Quiz',
              workspaceId: 'ws',
            },
          ],
          updatedAt: '',
          workspaceId: 'ws',
        },
      ],
      workspaces: [
        {
          chapters: [],
          hidden: false,
          iconId: 'i',
          items: [
            {
              chapterId: null,
              createdAt: '',
              id: 'f1',
              position: 0,
              state: 'done',
              title: 'Cells.pdf',
              type: 'file',
            },
            {
              chapterId: null,
              createdAt: '',
              id: 'qz',
              position: 1,
              title: 'Quiz',
              type: 'material',
            },
          ],
          name: 'Bio',
          workspaceId: 'ws',
        },
      ],
    },
  }),
  useWorkspaceStudy: () => ({
    data: {
      enabled: study.enabled,
      items: [
        { fileId: 'f1', state: 'done', updatedAt: '2026-10-09T10:00:00Z' },
      ],
      quickReview: study.quickReview,
      recentAttempts: [],
      reviewable: 4,
      unfinished: study.unfinished,
    },
  }),
}));

const render = (planId?: string) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <StudyPage onOpenItem={() => {}} planId={planId} workspaceId="ws" />
    </QueryClientProvider>
  );

it('lists every item with its read state, attempts and latest result', () => {
  const html = render();
  expect(html).toContain('Cells.pdf');
  expect(html).toContain(m.progress_read_on({ date: '' }).trim());
  expect(html).toContain(
    `${m.progress_attempts({ count: 2 })} · ${m.question_ui_question_count({ count: 10 })}`
  );
  expect(html).toContain(m.flashcards_score({ correct: 3, total: 4 }));
  // A practised quiz or set opens its latest result.
  expect(html).toContain('href="/quizzes/attempts/at_2"');
  expect(html).toContain('href="/flashcards/attempts/fa_1"');
});

it('leads with Continue and the whole workspace review, continuing an unfinished session', () => {
  let html = render();
  expect(html).toContain(m.study_continue());
  expect(html).toContain(m.study_start_workspace_review());
  expect(html).toContain('href="/learning/review/ws"');
  study.unfinished = {
    answered: 1,
    id: 's1',
    lastAnswerAt: new Date().toISOString(),
    total: 3,
  };
  try {
    html = render();
    expect(html).toContain(m.study_continue_workspace_review());
    expect(html).toContain('1 of 3');
  } finally {
    study.unfinished = undefined;
  }
});

it('shows Quick review cards without credits', () => {
  study.quickReview = [
    {
      front: 'Golgi',
      itemId: 'c1',
      kind: 'card',
      materialId: 'set',
      materialTitle: 'Cards',
    },
  ];
  try {
    const html = render();
    expect(html).toContain('Golgi');
    expect(html).not.toContain(m.material_attribution_title());
  } finally {
    study.quickReview = [];
  }
});

it('shows the picked plan: its steps as the list and its own review', () => {
  expect(render()).toContain(m.plan_default());
  const html = render('p1');
  expect(html).toContain('Winter exams');
  expect(html).toContain('Cells.pdf');
  expect(html).toContain(m.study_start_plan_review());
  expect(html).toContain(m.plan_add_steps());
  expect(html).toContain(m.plan_rename());
});

it('points to settings and keeps the settings rows while study progress is hidden', () => {
  study.enabled = false;
  try {
    const html = render();
    expect(html).toContain(m.study_hidden_here());
    expect(html).toContain(m.study_reset_title());
    for (const gone of [m.study_start_workspace_review(), 'Cells.pdf'])
      expect(html).not.toContain(gone);
  } finally {
    study.enabled = true;
  }
});

it('says there is nothing to study yet in an empty workspace, and lists unchaptered items under Others', () => {
  expect(render()).toContain(m.study_others());
  content.empty = true;
  try {
    const html = render();
    expect(html).toContain(m.study_empty());
    expect(html).not.toContain(m.progress_nothing_shown());
  } finally {
    content.empty = false;
  }
});
