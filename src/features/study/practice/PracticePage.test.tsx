import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Practice } from '@/api/types';
import { m } from '@/i18n';
import { PracticePage } from './PracticePage';
import { StudyPanel } from './StudyPanel';

const page = vi.hoisted(() => ({
  data: undefined as Practice | undefined,
  role: 'viewer' as 'owner' | 'viewer',
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/api/hooks', () => ({
  usePractice: () => ({ data: page.data, isError: false, isPending: false }),
  useTopics: () => ({
    data: [
      { description: '', fileIds: [], id: 't1', name: 'Osmosis', order: 0 },
    ],
  }),
  useWorkspace: () => ({ data: { name: 'Biology 101', role: page.role } }),
}));

const practice = (members?: number): Practice => ({
  members,
  quizzes: [
    {
      average: members ? 0.62 : undefined,
      best: { correct: 5, total: 8 },
      id: 'qz',
      questions: 8,
      title: 'Osmosis check',
      topicId: 't1',
      triedBy: members ? 5 : undefined,
    },
  ],
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
  renderToStaticMarkup(<PracticePage search={{}} workspaceId="ws" />);

it('shows a member Suggested, their own review and every quiz with their best', () => {
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
});

it('shows owners how members use each quiz', () => {
  page.role = 'owner';
  page.data = practice(6);
  const html = render();
  expect(html).toContain(m.workspace_members_count({ count: 6 }));
  expect(html).toContain(m.practice_tried_of({ members: 6, tried: 5 }));
  expect(html).toContain('62%');
  expect(html).not.toContain(m.practice_suggested());
  expect(html).not.toContain(m.practice_only_you());
});

it('lists Study pages by role, Practice the one built', () => {
  const member = renderToStaticMarkup(
    <StudyPanel active="practice" onOpen={() => {}} staff={false} />
  );
  expect(member.indexOf(m.study_panel_my_results())).toBeLessThan(
    member.indexOf(m.study_panel_practice())
  );
  expect(member).not.toContain(m.study_panel_members());
  const owner = renderToStaticMarkup(
    <StudyPanel active="practice" onOpen={() => {}} staff />
  );
  expect(owner.indexOf(m.study_panel_members())).toBeLessThan(
    owner.indexOf(m.study_panel_assignments())
  );
  expect(owner).toContain('aria-current="page"');
});
