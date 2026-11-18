import { parseHTML } from 'linkedom';
import { act, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import { getLocale, m } from '@/i18n';
import { learnerView } from '@/mocks/answerKeys';
import { type Answer, type Answers, scorePart } from './grade';

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

const matching = exampleQuestion('match', {
  options: ['Stores DNA', 'Makes ATP', 'Unused choice'],
  pairs: [
    { left: 'Nucleus', right: 0 },
    { left: 'Mitochondria', right: 1 },
  ],
  type: 'matching',
});

/** Each matching row's cells by their accessible names, with the checked one. */
function gridRows() {
  return [...host.querySelectorAll('[role="radiogroup"]')].map((row) =>
    [...row.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(
      (cell) => ({ cell, name: cell.getAttribute('aria-label') })
    )
  );
}

it('answers matching on the grid, storing the picked option text per row', async () => {
  // Learners read the options shuffled, so the answer is the text.
  const question = learnerView(matching);
  let stored: Answer | undefined;
  function Taking() {
    const [answers, setAnswers] = useState<Answers>({});
    return (
      <QuestionRunner
        answers={answers}
        onChange={(part, value) => {
          stored = value;
          setAnswers({ ...answers, [part]: value });
        }}
        question={question}
      />
    );
  }
  root = createRoot(host);
  await act(async () => root.render(<Taking />));
  const pick = gridRows()[1].find(
    ({ name }) => name === 'Mitochondria: Makes ATP'
  );
  await act(async () => pick?.cell.click());
  expect(stored).toEqual({ '1': 'Makes ATP' });
  expect(pick?.cell.checked).toBe(true);
});

it('reviews matching on the grid: a wrong row red, the correct answer listed under it', async () => {
  const question = structuredClone(matching);
  question.parts[0].marks = 2;
  question.parts[0].awarded = 1;
  question.parts[0].itemResults = [true, false];
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QuestionRunner
        answers={{ 'match-part': { '0': 'Stores DNA', '1': 'Unused choice' } }}
        question={question}
        review
      />
    )
  );
  const [right, wrong] = gridRows();
  expect(right[0].cell.className).toContain('bg-tint-success-fg');
  expect(wrong[2].cell.checked).toBe(true);
  expect(wrong[2].cell.className).toContain('bg-tint-error-fg');
  // Only the member's own picks are marked (Epo 2026-11-18); the correct
  // answer lists apart.
  expect(wrong[1].cell.className).not.toContain('tint-success-fg');
  expect(host.textContent).toContain('Correct answer');
  expect(
    gridRows()
      .flat()
      .every(({ cell }) => cell.getAttribute('aria-disabled') === 'true')
  ).toBe(true);
});

it('shows a shuffled mcq in its order, the locked option in place, and grades the pick right', async () => {
  const authored = exampleQuestion('shuffled', {
    correct: [1],
    locked: [2],
    options: ['Nucleus', 'Mitochondria', 'None of these'],
    shuffle: true,
    type: 'mcq',
  });
  // The learner view's order: Mitochondria first, None of these locked last.
  const question = {
    ...learnerView(authored),
    parts: [
      {
        ...learnerView(authored).parts[0],
        answer: {
          options: ['Nucleus', 'Mitochondria', 'None of these'],
          order: [1, 0, 2],
          type: 'mcq' as const,
        },
      },
    ],
  };
  let answers: Answers = {};
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QuestionRunner
        answers={answers}
        onChange={(part, value) => {
          answers = { ...answers, [part]: value };
        }}
        question={question}
      />
    )
  );
  const options = [...host.querySelectorAll('button[aria-pressed]')];
  expect(options.map((o) => o.textContent)).toEqual([
    expect.stringContaining('Mitochondria'),
    expect.stringContaining('Nucleus'),
    expect.stringContaining('None of these'),
  ]);
  await act(async () => (options[0] as HTMLButtonElement).click());
  expect(answers).toEqual({ 'shuffled-part': [1] });
  expect(scorePart(authored.parts[0], answers['shuffled-part']).awarded).toBe(
    1
  );
});
