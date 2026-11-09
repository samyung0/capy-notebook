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

// Q729: right after Submit, while a marking run holds the attempt, the page
// says it is being marked.
it('says Marking… while a marking run holds the attempt', async () => {
  const attempt = {
    answers: {},
    id: 'at1',
    mark: 1,
    marking: true,
    questions: [],
    total: 3,
    waitingAnswers: 1,
    waitingMarks: 2,
  } as unknown as AssignmentAttempt;
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <AssignmentSubmitted
        assignment={{ title: 'Cells' } as Assignment}
        attempt={attempt}
        onSeeResults={() => {}}
      />
    )
  );
  expect(document.querySelector('[data-marking]')?.textContent).toContain(
    m.quiz_grading()
  );
  act(() => root.unmount());
});
