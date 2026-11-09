import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { ApiError, parseErrorBody } from '@/api/client';
import type { Question } from '@/api/types';
import {
  exampleAnswers,
  exampleQuestion,
} from '@/features/questions/questionFixtures';
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

/* In the app, out of credits or after a failure, a part stays Not marked: it can
   be checked again, and the result counts it apart from wrong, in the total. */
function NotMarkedQuiz() {
  const open = exampleQuestion('q_open', exampleAnswers[6]);
  const control = useMemoryRun(
    async () =>
      ({
        question: {
          ...open,
          parts: open.parts.map((part) => ({
            ...part,
            awarded: 0,
            marks: 4,
            pending: true,
          })),
        },
      }) as never
  );
  return (
    <AttemptBody
      control={control}
      name="Quiz"
      questions={[{ ...open, parts: [{ ...open.parts[0], marks: 4 }] }]}
      trail={[]}
    />
  );
}

it('shows a part left Not marked in the result as not marked, its marks in the total', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<NotMarkedQuiz />));
  const check = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === m.question_ui_check()
  );
  await act(async () => check?.click());
  const html = host.innerHTML;
  expect(html).toContain(m.assignment_not_marked());
  expect(html).toContain(m.quiz_question_not_marked({ number: 1 }));
  expect(html).toContain(m.result_not_marked({ count: 1 }));
  expect(html).not.toContain(m.result_wrong({ count: 1 }));
  expect(host.textContent).toContain('— / 4');
  expect(host.textContent).toContain(
    m.result_type_marks({ awarded: '—', max: '4' })
  );
  // Its marks stay in the score's total.
  expect(host.textContent).toContain('0 / 4');
  act(() => root.unmount());
  host.remove();
});

const three = ['a', 'b', 'c'].map((id) => exampleQuestion(id));

function SplitQuiz() {
  const control = useMemoryRun(
    async (id) =>
      ({
        question: {
          ...three.find((q) => q.id === id),
          parts: three[0].parts.map((part) => ({ ...part, awarded: 1 })),
        },
      }) as never
  );
  return (
    <AttemptBody
      control={control}
      inApp
      name="Quiz"
      questions={three}
      trail={[]}
    />
  );
}

it("the app's study page never strands a question skipped, and ends on a Result row", async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<SplitQuiz />));
  const press = (name: string) =>
    act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === name)
        ?.click()
    );
  // The last question first: the first two are still left.
  await act(async () =>
    host.querySelector<HTMLElement>('[data-question-row="c"]')?.click()
  );
  await press(m.question_ui_check());
  await press(m.quiz_study_go_to({ number: 1 }));
  expect(
    host.querySelector('[data-question-id]')?.getAttribute('data-question-id')
  ).toBe('a');
  await press(m.question_ui_check());
  await press(m.action_next());
  await press(m.question_ui_check());
  expect(host.textContent).toContain(m.quiz_study_result());
  expect(host.textContent).toContain(m.quiz_redo());
  // A checked question opens from the list, and a way back to the result.
  await act(async () =>
    host.querySelector<HTMLElement>('[data-question-row="c"]')?.click()
  );
  expect(
    host.querySelector('[data-question-id]')?.getAttribute('data-question-id')
  ).toBe('c');
  await press(m.quiz_study_see_result());
  expect(host.textContent).toContain(m.quiz_redo());
  await act(async () => root.unmount());
  host.remove();
});

it('a try picked up again opens at the first question not checked', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const done = {
    ...three[0],
    parts: three[0].parts.map((part) => ({ ...part, awarded: 1 })),
  };
  await act(async () =>
    root.render(
      <AttemptBody
        control={
          {
            check: vi.fn(),
            redo: vi.fn(),
            run: { answers: {}, checked: [done] },
          } as never
        }
        inApp
        name="Quiz"
        questions={three}
        trail={[]}
      />
    )
  );
  expect(
    host.querySelector('[data-question-id]')?.getAttribute('data-question-id')
  ).toBe('b');
  await act(async () => root.unmount());
  host.remove();
});
