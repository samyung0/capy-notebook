import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { ApiError, parseErrorBody } from '@/api/client';
import type { Question } from '@/api/types';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import { getLocale, m } from '@/i18n';

/* A question with no answers says so at its Check, and neither the finish nor
   the score counts it (Epo 2026-11-05). */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/userToast', () => ({ userToast: toast }));

const { createRoot } = await import('react-dom/client');
const { AttemptBody } = await import('./AttemptBody');
const { useMemoryRun } = await import('./quizRun');

const answered = exampleQuestion('q1');
const none: Question = {
  ...exampleQuestion('q2'),
  parts: [{ ...exampleQuestion('q2').parts[0], marks: 5 }],
};

function Quiz() {
  const control = useMemoryRun(async (id) => {
    if (id === none.id)
      throw new ApiError(
        404,
        'Not Found',
        'the question is not in this quiz',
        parseErrorBody({ errors: [{ message: 'question_no_answers' }] })
      );
    return {
      question: {
        ...answered,
        parts: answered.parts.map((part) => ({ ...part, awarded: 1 })),
      },
    } as never;
  });
  return (
    <AttemptBody
      control={control}
      name="Quiz"
      questions={[answered, none]}
      trail={[]}
    />
  );
}

it('shows No answers configured at its Check and leaves it out of the score', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Quiz />));
  const checks = () =>
    [...host.querySelectorAll('button')].filter(
      (button) => button.textContent === m.question_ui_check()
    );

  await act(async () => checks()[1]?.click());
  expect(host.textContent).toContain(m.quiz_no_answers_configured());
  expect(toast).not.toHaveBeenCalled();
  expect(checks()).toHaveLength(1);
  // Taking it out leaves one question of one mark to check.
  expect(host.textContent).toContain(
    m.quiz_checked_count({ checked: 0, total: 1 })
  );

  await act(async () => checks()[0]?.click());
  // The result opens with the other question checked, 1 of 1 mark, not 1 of 6.
  expect(host.textContent).toContain(m.quiz_redo());
  expect(host.textContent).toContain(m.quiz_no_answers_configured());
  expect(host.textContent).toContain('1 / 1');
  act(() => root.unmount());
  host.remove();
});
