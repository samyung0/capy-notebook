import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { Assignment, AssignmentReport } from '@/api/types';
import { getLocale, m } from '@/i18n';

/* A member's submission that doesn't count yet stays on the list while it waits:
   their two answers to a question are two rows, each opening its own attempt. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const opened = vi.hoisted(() => ({ ids: [] as string[] }));
const runAI = vi.hoisted(() => vi.fn());
vi.mock('@/api/hooks', () => ({
  useApproveAssignmentAIMarks: () => ({ isPending: false, mutate: vi.fn() }),
  useAssignmentAttempt: (id: string) => {
    opened.ids.push(id);
    return { data: undefined, isPending: true };
  },
  useMarkAssignmentAnswer: () => ({ isPending: false, mutate: () => {} }),
  useMarkAssignmentWithAI: () => ({ isPending: false, mutate: runAI }),
}));
vi.mock('@/components/ui/Select', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  );
  return {
    Select: Pass,
    SelectContent: () => null,
    SelectItem: () => null,
    SelectTrigger: Pass,
    SelectValue: Pass,
  };
});

const { createRoot } = await import('react-dom/client');
const { ApproveTab } = await import('./ApproveTab');

const question = {
  id: 'q1',
  parts: [{ answer: { type: 'open' }, id: 'p1', marks: 3 }],
  stem: [],
};
const answer = (
  attemptId: string,
  attemptNumber: number,
  waiting: boolean
) => ({
  attemptId,
  attemptNumber,
  awarded: 1,
  marks: 3,
  questionId: 'q1',
  userId: 'u1',
  waiting,
});
const report = {
  answers: [answer('at_counted', 3, false), answer('at_waiting', 1, true)],
  members: [{ attemptId: 'at_counted', name: 'Ada', userId: 'u1' }],
  questions: [{ parts: [], question, submitted: 1 }],
} as unknown as AssignmentReport;

it('lists a member twice by attempt and opens the one picked', async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <ApproveTab
        assignment={
          { attempts: 3, id: 'as1', workspaceId: 'ws1' } as Assignment
        }
        report={report}
        search={{}}
      />
    )
  );
  const rows = [...document.querySelectorAll('li button')] as HTMLElement[];
  // Waiting first.
  expect(rows[0].textContent).toContain(
    `Ada · ${m.assignment_attempt_number({ number: 1 })}`
  );
  expect(rows[0].textContent).toContain(m.assignment_not_marked());
  expect(rows[1].textContent).toContain(
    `Ada · ${m.assignment_attempt_number({ number: 3 })}`
  );
  expect(opened.ids.at(-1)).toBe('at_waiting');
  await act(async () => rows[1].click());
  expect(opened.ids.at(-1)).toBe('at_counted');
  act(() => root.unmount());
});

// Finding 2: a paper still to read waits on every question, a closed-only one
// too: Approve lists it with Mark with AI to read the paper again.
it('lists a paper waiting to be read on a question with no open part', async () => {
  const closed = {
    id: 'q2',
    parts: [{ answer: { type: 'mcq' }, id: 'p2', marks: 1 }],
    stem: [],
  };
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <ApproveTab
        assignment={
          { attempts: 1, id: 'as1', workspaceId: 'ws1' } as Assignment
        }
        report={
          {
            answers: [
              { ...answer('at_paper', 1, true), marks: 1, questionId: 'q2' },
            ],
            members: [{ attemptId: 'at_paper', name: 'Ada', userId: 'u1' }],
            questions: [{ parts: [], question: closed, submitted: 1 }],
          } as unknown as AssignmentReport
        }
        search={{}}
      />
    )
  );
  expect(document.body.textContent).not.toContain(m.assignment_no_open());
  expect(document.querySelectorAll('li button')).toHaveLength(1);
  expect(
    [...document.querySelectorAll('button')].some(
      (button) => button.textContent === m.assignment_mark_with_ai()
    )
  ).toBe(true);
  act(() => root.unmount());
});

// Q725: under manual marking a paper whose read failed or never ran offers Read
// papers again where Mark with AI would sit; it runs the same call, which
// reads without grading.
it('offers Read papers again under manual marking while a paper waits to be read', async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <ApproveTab
        assignment={
          {
            attempts: 1,
            id: 'as1',
            manage: { marking: 'manual' },
            workspaceId: 'ws1',
          } as Assignment
        }
        report={{ ...report, papersToRead: 1 }}
        search={{}}
      />
    )
  );
  const again = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === m.assignment_read_papers_again()
  );
  expect(again).toBeDefined();
  await act(async () => again?.click());
  expect(runAI).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

// Q730: a paper whose file can't be read says so on its rows, beside No
// credits and Grade Error.
it("badges a row whose paper file can't be read", async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <ApproveTab
        assignment={
          { attempts: 1, id: 'as1', workspaceId: 'ws1' } as Assignment
        }
        report={
          {
            ...report,
            answers: [{ ...answer('at_paper', 1, true), aiError: 'file' }],
          } as unknown as AssignmentReport
        }
        search={{}}
      />
    )
  );
  expect(document.querySelector('li button')?.textContent).toContain(
    m.assignment_cant_read_file()
  );
  act(() => root.unmount());
});

// Q729: a row whose answer a marking run holds shows Marking… in place of its
// badge or waiting text; the others keep theirs.
it('shows Marking… on the rows being marked only', async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <ApproveTab
        assignment={
          { attempts: 3, id: 'as1', workspaceId: 'ws1' } as Assignment
        }
        report={
          {
            ...report,
            answers: [
              { ...answer('at_waiting', 1, true), marking: true },
              answer('at_other', 2, true),
            ],
          } as unknown as AssignmentReport
        }
        search={{}}
      />
    )
  );
  const rows = [...document.querySelectorAll('li button')];
  expect(rows.map((row) => !!row.querySelector('[data-marking]'))).toEqual([
    true,
    false,
  ]);
  expect(rows[1]?.textContent).toContain(m.assignment_not_marked());
  act(() => root.unmount());
});
