import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { Question } from '@/features/questions/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const save = vi.hoisted(() => vi.fn());
vi.mock('@/api/hooks', () => ({
  saveAssignmentAnswers: save,
  useSubmitAssignmentAttempt: () => ({ isPending: false, mutate: vi.fn() }),
}));
// The rest is real: the app's shared QueryClient loads through blockCode.
vi.mock('@tanstack/react-query', async (load) => ({
  ...(await load<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('./LazyPaper', () => ({ PaperPane: () => null }));
vi.mock('@/features/quizzes/QuestionRunner', () => ({
  QuestionRunner: ({
    onChange,
  }: {
    onChange: (part: string, value: string) => void;
  }) => (
    <button data-type onClick={() => onChange('p1', 'typed')} type="button">
      type
    </button>
  ),
}));

const { createRoot } = await import('react-dom/client');
const { AssignmentPreview } = await import('./AssignmentPreview');

const question = (id: string, partId: string): Question => ({
  id,
  labels: 'letters',
  layout: 'paper',
  parts: [
    {
      answer: { accepted: [], type: 'open' },
      blocks: [{ text: `Question ${id}`, type: 'text' }],
      id: partId,
      marks: 2,
      solution: [],
    },
  ],
  stem: [],
});

it('answers on the page alone, the list ticking them', async () => {
  const container = document.getElementById('root') as unknown as HTMLElement;
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <AssignmentPreview
        questions={[question('q1', 'p1'), question('q2', 'p2')]}
      />
    )
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-type]')?.click()
  );
  // The answered question's number says so.
  expect(
    container
      .querySelector('[data-question-number="q1"]')
      ?.getAttribute('aria-label')
  ).toContain(m.assignment_legend_answered());
  expect(save).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
