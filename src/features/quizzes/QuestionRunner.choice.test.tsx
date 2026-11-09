import { parseHTML } from 'linkedom';
import { act, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import { getLocale, m } from '@/i18n';
import { learnerView } from '@/mocks/answerKeys';
import type { Answers } from './grade';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const { createRoot } = await import('react-dom/client');
const { QuestionRunner } = await import('./QuestionRunner');

const host = document.createElement('div');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
afterEach(() => act(() => root.unmount()));

/** A learner question (no key) answered by clicking A then B. */
async function answerAThenB(correct: number[]) {
  const question = learnerView(
    exampleQuestion('q', {
      correct,
      options: ['Nucleus', 'Mitochondria', 'Ribosome'],
      type: 'mcq',
    })
  );
  function Taking() {
    const [answers, setAnswers] = useState<Answers>({});
    return (
      <QuestionRunner
        answers={answers}
        onChange={(part, value) => setAnswers({ ...answers, [part]: value })}
        question={question}
      />
    );
  }
  root = createRoot(host);
  await act(async () => root.render(<Taking />));
  const options = () => [...host.querySelectorAll('button[aria-pressed]')];
  for (const i of [0, 1])
    await act(async () => (options()[i] as HTMLButtonElement).click());
  return {
    hint: host.textContent?.includes(m.question_ui_multiple_answers()),
    pressed: options().map((o) => o.getAttribute('aria-pressed')),
  };
}

it('answers a one-correct mcq as a single choice, without the hint', async () => {
  expect(await answerAThenB([1])).toEqual({
    hint: false,
    pressed: ['false', 'true', 'false'],
  });
});

it('answers a several-correct mcq with checkboxes under the hint', async () => {
  expect(await answerAThenB([0, 2])).toEqual({
    hint: true,
    pressed: ['true', 'true', 'false'],
  });
});
