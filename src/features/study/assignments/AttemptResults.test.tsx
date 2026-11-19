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

it('opens a question as the report does, and a click on the question folds it', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  Object.assign(window, { getSelection: () => null });
  const root = createRoot(host);
  const open = {
    answer: { accepted: [], type: 'open' },
    blocks: [{ text: 'Explain how water enters', type: 'text' }],
    id: 'p1',
    marks: 2,
    markscheme: [{ marks: 2, text: 'Names the membrane' }],
    pending: true,
    solution: [],
  };
  await act(async () =>
    root.render(
      <AttemptResults
        assignment={{ postedBy: 'Kate', workspaceId: 'ws1' } as Assignment}
        attempt={
          {
            ...attempt,
            answers: { p1: 'By osmosis' },
            gradesHidden: false,
            questions: [{ ...attempt.questions[0], parts: [open] }],
            showAnswers: true,
            userName: 'Ben',
            waitingMarks: 2,
          } as unknown as AssignmentAttempt
        }
      />
    )
  );
  // A question waiting for its mark opens first: what it is on the left,
  // its marking points beside, each with what it was awarded (a member's
  // view: staff's mark menus need a fuller DOM than this one).
  const text = host.textContent ?? '';
  expect(text).toContain(
    `Q1 · ${m.question_ui_open_answer()} · ${m.question_ui_marks({ count: 2 })}`
  );
  expect(text).toContain(m.assignment_awarded());
  expect(text).toContain('Names the membrane');
  const click = (element: Element | null) =>
    act(() => {
      element?.dispatchEvent(
        new window.Event('pointerdown', { bubbles: true })
      );
      element?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
  // The answer's side keeps it open; the question's side folds it.
  click(host.querySelector('[data-result-body] p'));
  expect(host.querySelector('[data-result-body]')).not.toBeNull();
  click(host.querySelector('li > div > p:nth-child(2)'));
  expect(host.querySelector('[data-result-body]')).toBeNull();
  act(() => root.unmount());
});

// Epo 2026-11-18: a question of several parts lays each out as its own row,
// as the report's Questions tab does.
it('lists each part of a question as its own row', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const marked = (id: string, text: string) => ({
    ...part(id),
    awarded: 2,
    blocks: [{ text, type: 'text' }],
  });
  await act(async () =>
    root.render(
      <AttemptResults
        assignment={{ postedBy: 'Kate', workspaceId: 'ws1' } as Assignment}
        attempt={
          {
            ...attempt,
            answers: { a: 'osmosis', b: 'osmosis' },
            gradesHidden: false,
            questions: [
              {
                ...attempt.questions[0],
                parts: [marked('a', 'First part'), marked('b', 'Second part')],
                stem: [{ text: 'A shared stem', type: 'text' }],
              },
            ],
            showAnswers: true,
            userName: 'Ben',
          } as unknown as AssignmentAttempt
        }
      />
    )
  );
  const rows = [...host.querySelectorAll('li button[aria-expanded]')].map(
    (row) => row.textContent ?? ''
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain('Q1 (a)');
  expect(rows[0]).toContain('First part');
  expect(rows[1]).toContain('Q1 (b)');
  act(() => root.unmount());
});
