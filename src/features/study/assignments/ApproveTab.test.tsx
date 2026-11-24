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
// A phone's width: Grading's lists and pane one screen at a time.
Object.assign(window, {
  matchMedia: () => ({ addListener() {}, matches: false, removeListener() {} }),
});

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
        onExitFullscreen={() => {}}
        report={report}
        search={{}}
      />
    )
  );
  const rows = [
    ...document.querySelectorAll('[data-answer-row]'),
  ] as HTMLElement[];
  // Waiting first.
  expect(rows[0].textContent).toContain(
    `Ada · ${m.assignment_attempt_number({ number: 1 })}`
  );
  expect(rows[0].textContent).toContain(m.assignment_not_graded_badge());
  expect(rows[1].textContent).toContain(
    `Ada · ${m.assignment_attempt_number({ number: 3 })}`
  );
  expect(opened.ids.at(-1)).toBe('at_waiting');
  await act(async () => rows[1].click());
  expect(opened.ids.at(-1)).toBe('at_counted');
  act(() => root.unmount());
});

// Finding 2: a paper still to read waits on every question, a closed-only one
// too: Approve lists it with Grade with AI to read the paper again.
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
        onExitFullscreen={() => {}}
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
  expect(document.querySelectorAll('[data-answer-row]')).toHaveLength(1);
  expect(
    [...document.querySelectorAll('button')].some(
      (button) =>
        button.textContent === m.assignment_grade_count_with_ai({ count: 1 })
    )
  ).toBe(true);
  act(() => root.unmount());
});

// Q725: under manual marking a paper whose read failed or never ran offers Read
// papers again where Grade with AI would sit; it runs the same call, which
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
        onExitFullscreen={() => {}}
        report={{ ...report, papersToRead: 1 }}
        search={{}}
      />
    )
  );
  const again = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === m.assignment_read_papers_again()
  );
  expect(again).toBeDefined();
  // Manual grading grades, it has nothing to approve (Epo 2026-11-20).
  expect(document.body.textContent).toContain(m.assignment_to_grade());
  expect(document.body.textContent).toContain(m.assignment_start_grading());
  expect(document.body.textContent).not.toContain(
    m.assignment_section_to_approve()
  );
  await act(async () => again?.click());
  expect(runAI).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

// Q730, Epo 2026-11-14: whatever stopped the AI (no credits, a file it can't
// read, an error), the row reads Not graded; the pane says why.
it("badges a row whose paper file can't be read Not graded", async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <ApproveTab
        assignment={
          { attempts: 1, id: 'as1', workspaceId: 'ws1' } as Assignment
        }
        onExitFullscreen={() => {}}
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
  expect(document.querySelector('[data-answer-row]')?.textContent).toContain(
    m.assignment_not_graded_badge()
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
        onExitFullscreen={() => {}}
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
  const rows = [...document.querySelectorAll('[data-answer-row]')];
  expect(rows.map((row) => !!row.querySelector('[data-marking]'))).toEqual([
    true,
    false,
  ]);
  expect(rows[1]?.textContent).toContain(m.assignment_not_graded_badge());
  act(() => root.unmount());
});

// P1 (Epo 2026-11-14): a phone goes questions → members → answer; past the
// question list the tab marks itself, so CSS hides the workspace header and
// the report's head.
it('steps from a question to its members and on to an answer', async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <ApproveTab
        assignment={
          { attempts: 3, id: 'as1', workspaceId: 'ws1' } as Assignment
        }
        onExitFullscreen={() => {}}
        report={report}
        search={{}}
      />
    )
  );
  const drill = () =>
    document
      .querySelector('[data-approve-drill]')
      ?.getAttribute('data-approve-drill');
  expect(drill()).toBeUndefined();
  await act(async () =>
    (document.querySelector('[data-question-row]') as HTMLElement).click()
  );
  expect(drill()).toBe('members');
  await act(async () =>
    (document.querySelector('[data-answer-row]') as HTMLElement).click()
  );
  expect(drill()).toBe('answer');
  act(() => root.unmount());
});

// Epo 2026-11-19: Grading lists every question, the AI's marked AI marked.
it('lists questions marked by rule too, AI marked on the written ones', async () => {
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
        onExitFullscreen={() => {}}
        report={
          {
            answers: [
              answer('at_1', 1, true),
              { ...answer('at_1', 1, false), marks: 1, questionId: 'q2' },
            ],
            members: [{ attemptId: 'at_1', name: 'Ada', userId: 'u1' }],
            questions: [
              { parts: [], question, submitted: 1 },
              { parts: [], question: closed, submitted: 1 },
            ],
          } as unknown as AssignmentReport
        }
        search={{}}
      />
    )
  );
  const rows = [
    ...document.querySelectorAll('[data-question-row]'),
  ] as HTMLElement[];
  expect(rows.map((row) => row.dataset.questionRow)).toEqual(['q1', 'q2']);
  expect(rows[0].textContent).toContain(m.assignment_ai_marked());
  expect(rows[1].textContent).not.toContain(m.assignment_ai_marked());
  act(() => root.unmount());
});

// Epo 2026-11-20 ("a file is not a quiz question"): a graded quiz from a file
// lists its members with no questions or Overview, a phone starting there.
it("lists a file quiz's members with no questions column", async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <ApproveTab
        assignment={
          {
            attempts: 3,
            id: 'as1',
            manage: { marking: 'manual' },
            paperFile: true,
            workspaceId: 'ws1',
          } as unknown as Assignment
        }
        onExitFullscreen={() => {}}
        report={report}
        search={{}}
      />
    )
  );
  expect(document.querySelector('[data-question-row]')).toBeNull();
  expect(document.querySelectorAll('[data-answer-row]')).toHaveLength(2);
  // The members are the phone's first screen, not a step in.
  expect(document.querySelector('[data-approve-drill]')).toBeNull();
  expect(document.body.textContent).not.toContain(m.assignment_overview());
  // Manual grading grades, it has nothing to approve (Epo 2026-11-20).
  expect(document.body.textContent).toContain(m.assignment_start_grading());
  expect(document.body.textContent).toContain(
    m.assignment_to_grade_count({ count: 1 })
  );
  act(() => root.unmount());
});
