import { parseHTML } from 'linkedom';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { getLocale, m } from '@/i18n';
import { readQuestions, seedQuiz, writeQuestion } from './liveQuiz';

/* A note embed's question added and left blank goes when its dialog closes;
   one a co-editor has written in stays. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

vi.mock('@/components/ui/Dialog', () => ({ ConfirmDialog: () => null }));
vi.mock('./QuizPage', () => ({ QuizQuestionList: () => null }));
vi.mock('@/features/questions/QuestionDialog', () => ({
  QuestionDialog: ({ onClose }: { onClose: () => void }) => (
    <button data-close onClick={onClose} type="button" />
  ),
}));

const { createRoot } = await import('react-dom/client');
const { useQuizQuestions } = await import('./liveQuizRooms');
const { QuizForm } = await import('./QuizForm');

let content: Y.Doc;
let keys: Y.Doc;
let root: ReturnType<typeof createRoot>;
let host: HTMLElement;

function Form() {
  const questions = useQuizQuestions(content, keys);
  return (
    <QuizForm
      content={content}
      keys={keys}
      name=""
      questions={questions}
      quizId="qz1"
      status="saved"
      undo={null}
    />
  );
}

const list = () => readQuestions(content, keys);
const addQuestion = async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Form />));
  const add = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === m.quiz_add_question()
  );
  await act(async () => add?.click());
};
const closeDialog = () =>
  act(async () =>
    host.querySelector<HTMLButtonElement>('button[data-close]')?.click()
  );

beforeEach(() => {
  content = new Y.Doc();
  keys = new Y.Doc();
  seedQuiz(content, keys, []);
});
afterEach(() => {
  act(() => root.unmount());
  content.destroy();
  keys.destroy();
});

it('removes an added question closed blank', async () => {
  await addQuestion();
  expect(list()).toHaveLength(1);
  await closeDialog();
  expect(list()).toHaveLength(0);
});

it('keeps an added question a co-editor has written in', async () => {
  await addQuestion();
  const [added] = list();
  await act(async () =>
    writeQuestion(content, keys, {
      ...added,
      stem: [{ text: 'Name a cell part.', type: 'text' }],
    })
  );
  await closeDialog();
  expect(list()).toHaveLength(1);
  expect(list()[0].stem).toEqual([{ text: 'Name a cell part.', type: 'text' }]);
});
