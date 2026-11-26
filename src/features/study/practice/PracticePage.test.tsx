import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Practice } from '@/api/types';
import { workspaceSections } from '@/features/workspace/WorkspaceRail';
import { m } from '@/i18n';
import { PracticePage } from './PracticePage';

const page = vi.hoisted(() => ({
  data: undefined as Practice | undefined,
  kind: 'class' as 'class' | 'personal',
  role: 'viewer' as 'owner' | 'editor' | 'viewer',
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/api/hooks', () => ({
  usePractice: () => ({ data: page.data, isError: false, isPending: false }),
  useStudyQuestions: () => ({ data: undefined }),
  useStudyTopics: () => ({ data: undefined }),
  useTopics: () => ({
    data: [
      { description: '', fileIds: [], id: 't1', name: 'Osmosis', order: 0 },
    ],
  }),
  useWorkspace: () => ({
    data: { kind: page.kind, name: 'Biology 101', role: page.role },
  }),
}));

const practice = (members?: number): Practice => ({
  items: [
    {
      average: members ? 0.62 : undefined,
      best: { correct: 5, total: 8 },
      covers: ['t1', 't2'],
      id: 'qz',
      kind: 'quiz',
      size: 8,
      title: 'Osmosis check',
      topicId: 't1',
      triedBy: members ? 5 : undefined,
    },
    {
      best: { correct: 14, total: 18 },
      covers: [],
      id: 'dk',
      kind: 'flashcards',
      size: 18,
      title: 'Osmosis cards',
    },
  ],
  members,
  reviews: [
    {
      best: { correct: 7, total: 10 },
      group: 'topic',
      lastAt: '2026-11-02T10:00:00Z',
      questions: 10,
      topicId: 't1',
    },
  ],
  suggestions: [
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
  ],
});

const render = () =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <PracticePage search={{}} workspaceId="ws" />
    </QueryClientProvider>
  );

it('shows a member Suggested, their own review and every quiz with their best', () => {
  page.kind = 'class';
  page.role = 'viewer';
  page.data = practice();
  const html = render();
  expect(html).toContain(m.practice_suggested());
  expect(html).toContain(m.review_reason_tricky_missed({ missed: 3 }));
  expect(html).toContain(m.practice_review_name({ topic: 'Osmosis' }));
  expect(html).toContain(m.practice_only_you());
  expect(html).toContain('Osmosis check');
  expect(html).toContain('7 / 10');
  expect(html).toContain('5 / 8');
  expect(html).toContain(m.practice_col_best());
  expect(html).not.toContain(m.practice_col_average());
  // The row itself practises (Epo 2026-11-13); a set lists with its cards,
  // and one without a topic reads "–".
  expect(html).toContain('role="link"');
  expect(html).toContain('Osmosis cards');
  expect(html).toContain('14 / 18');
  expect(html).toContain('>–<');
  // A quiz covers its topic and its questions' own (Epo 2026-11-15).
  expect(html).toContain('>+1<');
});

it("shows a class's owner how members use each quiz", () => {
  page.kind = 'class';
  page.role = 'owner';
  page.data = practice(6);
  const html = render();
  expect(html).not.toContain(m.workspace_members_count({ count: 6 }));
  expect(html).toContain(m.practice_tried_of({ members: 6, tried: 5 }));
  expect(html).toContain('62%');
  expect(html).not.toContain(m.practice_suggested());
  expect(html).not.toContain(m.practice_only_you());
});

it('lets the owner of a personal workspace practise, add and edit', () => {
  page.kind = 'personal';
  page.role = 'owner';
  page.data = practice();
  const html = render();
  expect(html).toContain(m.practice_suggested());
  expect(html).toContain(m.practice_practise());
  expect(html).toContain(m.practice_add());
  expect(html).not.toContain(m.practice_col_average());
});

// Epo 2026-11-11: Study's pages each have their own place on the rail; its
// order since Epo 2026-11-24.
it('gives each of the four people their rail', () => {
  const rail = (kind: 'class' | 'personal', role: 'owner' | 'viewer') =>
    workspaceSections({ kind, role }).map((section) => section.label);
  const dashboard = m.workspace_section_dashboard();
  const canvas = m.workspace_section_canvas();
  const after = [
    m.workspace_tab_study(),
    m.workspace_tab_files(),
    m.workspace_section_agent(),
  ];
  const members = m.study_panel_members();
  // A class's staff give out assignments and manage the members; their Study
  // is every member's marks, Practice a tab of Study for everyone (Epo
  // 2026-11-13).
  expect(rail('class', 'owner')).toEqual([
    dashboard,
    canvas,
    m.study_panel_assignments(),
    ...after,
    members,
  ]);
  // A class's members have their own Assignments (Epo 2026-11-25) and Study,
  // and see who the members are without marks; a personal workspace has no
  // Assignments (Epo 2026-11-21).
  expect(rail('class', 'viewer')).toEqual([
    dashboard,
    canvas,
    m.study_panel_assignments(),
    ...after,
    members,
  ]);
  for (const own of [rail('personal', 'owner'), rail('personal', 'viewer')])
    expect(own).toEqual([dashboard, canvas, ...after, members]);
  // A link or public visitor is no member: no Members, and no canvas.
  expect(
    workspaceSections({ kind: 'personal', role: '' as never }).map(
      (section) => section.label
    )
  ).toEqual([dashboard, ...after]);
});
