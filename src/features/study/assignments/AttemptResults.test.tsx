import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { Assignment, AssignmentAttempt } from '@/api/types';
import { getLocale, m } from '@/i18n';

/* Show grades Manual (S7): before release a member's results list their
   answers with no mark. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

vi.mock('@/api/hooks', () => ({
  useMarkAssignmentAnswer: () => ({ mutate: vi.fn() }),
  useStartAssignment: () => ({ isPending: false, mutate: vi.fn() }),
  useWorkspace: () => ({ data: undefined }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({ workspaceId: 'ws' }),
}));

const { createRoot } = await import('react-dom/client');
const { AttemptResults } = await import('./AttemptResults');

const part = (id: string) => ({
  answer: { accepted: ['osmosis'], type: 'short' },
  blocks: [{ text: 'Name it', type: 'text' }],
  id,
  marks: 2,
  solution: [],
});
const attempt = {
  answers: { p1: 'osmosis' },
  correct: 0,
  gradesHidden: true,
  mark: 0,
  questions: [
    {
      id: 'q1',
      labels: 'letters',
      layout: 'paper',
      parts: [part('p1')],
      stem: [],
    },
    {
      id: 'q2',
      labels: 'letters',
      layout: 'paper',
      parts: [part('p2')],
      stem: [],
    },
  ],
  status: 'submitted',
  submittedAt: '2026-11-08T10:00:00Z',
  title: 'Past paper',
  total: 0,
} as unknown as AssignmentAttempt;

it('lists answers without marks while grades wait for release', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <AttemptResults
        assignment={{ postedBy: 'Kate', workspaceId: 'ws1' } as Assignment}
        attempt={attempt}
      />
    )
  );
  const text = host.textContent ?? '';
  expect(text).toContain(m.assignment_grades_hidden_note({ name: 'Kate' }));
  expect(text).toContain(m.assignment_answered());
  expect(text).toContain(m.assignment_blank());
  expect(text).not.toContain('/ 2');
  act(() => root.unmount());
});

it("lets a task's maker attempt again, though they run it too", async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <AttemptResults
        assignment={
          {
            attempts: 3,
            manage: {},
            mine: { attemptsUsed: 1 },
            own: true,
            postedBy: 'Kate',
            workspaceId: '',
          } as Assignment
        }
        attempt={{ ...attempt, gradesHidden: false }}
      />
    )
  );
  expect(host.textContent).toContain(m.assignment_attempt_again());
  act(() => root.unmount());
});
