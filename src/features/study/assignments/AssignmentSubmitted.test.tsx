import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { Assignment, AssignmentAttempt } from '@/api/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
}));

const { createRoot } = await import('react-dom/client');
const { AssignmentSubmitted } = await import('./AssignmentSubmitted');

const show = async (attempt: Partial<AssignmentAttempt>) => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <AssignmentSubmitted
        assignment={{ title: 'Cells', workspaceId: 'ws1' } as Assignment}
        attempt={
          {
            answers: {},
            gradesHidden: false,
            id: 'at1',
            mark: 3,
            marking: false,
            questions: [],
            total: 4,
            waitingAnswers: 0,
            waitingMarks: 0,
            ...attempt,
          } as AssignmentAttempt
        }
        onSeeResults={() => {}}
      />
    )
  );
  return root;
};
const buttons = () =>
  [...document.querySelectorAll('a, button')].map((b) => b.textContent);

// Epo 2026-11-25: no mark so far. While anything waits (a marking run, an
// answer for staff) it is being graded, and the one way on is Assignments.
it('says it is being graded while a mark waits, with no mark', async () => {
  const root = await show({
    marking: true,
    waitingAnswers: 1,
    waitingMarks: 1,
  });
  expect(document.querySelector('[data-being-graded]')?.textContent).toBe(
    m.assignment_being_graded()
  );
  expect(document.body.textContent).not.toContain('3 / 4');
  expect(buttons()).toEqual([m.study_panel_assignments()]);
  act(() => root.unmount());
});

// Graded with its grades showing: its mark and See results alone.
it('shows the mark and See results once graded', async () => {
  const root = await show({});
  expect(document.body.textContent).toContain(
    m.assignment_submitted_hint({ title: 'Cells' })
  );
  expect(document.body.textContent).toContain('3 / 4');
  expect(buttons()).toEqual([m.assignment_see_results()]);
  act(() => root.unmount());
});
