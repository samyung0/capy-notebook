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
vi.mock('@/api/hooks', () => ({
  useAssignmentAttempt: (id: string) => {
    opened.ids.push(id);
    return { data: undefined, isPending: true };
  },
  useMarkAssignmentAnswer: () => ({ isPending: false, mutate: () => {} }),
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
