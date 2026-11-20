import { parseHTML } from 'linkedom';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { blankQuestion } from '@/features/questions/types';
import { getLocale, m } from '@/i18n';
import { readQuestions, seedQuiz } from './liveQuiz';

/* A question added stays, left as added (Epo 2026-11-15, as Google Forms);
   a room that turns read-only or refuses this person shows its strip. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
// The rail's tooltips check nodes against `Element`.
Object.assign(globalThis, {
  document,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  window,
});

const docs = vi.hoisted(() => ({
  content: null as unknown as Y.Doc,
  keys: null as unknown as Y.Doc,
  rooms: {} as Record<string, unknown>,
}));
vi.mock('./liveQuizRooms', async (original) => ({
  ...(await original<typeof import('./liveQuizRooms')>()),
  useQuizRooms: () => ({
    access: 'write',
    content: { doc: docs.content },
    keys: { doc: docs.keys },
    offline: null,
    presence: [],
    readOnlyCode: null,
    ready: true,
    recovery: null,
    sending: false,
    slowed: false,
    status: 'saved',
    undo: null,
    ...docs.rooms,
  }),
}));
// The cards' Add question, which adds after the open card.
vi.mock('./QuestionPane', () => ({
  QuestionPane: ({ onAdd }: { onAdd: (index: number) => void }) => (
    <button
      aria-label={m.quiz_add_question()}
      onClick={() => onAdd(0)}
      type="button"
    />
  ),
}));
vi.mock('@/api/hooks', () => ({ useTopics: () => ({ data: undefined }) }));
vi.mock('./QuizForm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./QuizForm')>()),
  QuizRecovery: () => null,
  quizImageUpload: () => null,
}));
vi.mock('./QuizPage', () => ({ QuizQuestionList: () => null }));

const { createRoot } = await import('react-dom/client');
const { QuizEditor } = await import('./QuizEditor');

const editor = () => (
  <QuizEditor copy={{ seed: null }} quizId="qz1" stored={[]} title="Cells" />
);
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
const show = () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return act(async () => root.render(editor()));
};
const addQuestion = () =>
  act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        `button[aria-label="${m.quiz_add_question()}"]`
      )
      ?.click()
  );
const list = () => readQuestions(docs.content, docs.keys);
const leave = () => act(() => root.unmount());

beforeEach(() => {
  docs.content = new Y.Doc();
  docs.keys = new Y.Doc();
  docs.rooms = {};
  seedQuiz(docs.content, docs.keys, [
    {
      ...blankQuestion(),
      stem: [{ text: 'Name a cell part.', type: 'text' }],
    },
  ]);
});
afterEach(() => {
  docs.content.destroy();
  docs.keys.destroy();
});

it('keeps an added question as the page goes', async () => {
  await show();
  await addQuestion();
  expect(list()).toHaveLength(2);
  leave();
  expect(list()).toHaveLength(2);
});

it('leaves the documents alone when the room went read-only', async () => {
  await show();
  await addQuestion();
  docs.rooms = { access: 'read' };
  await act(async () => root.render(editor()));
  expect(host.textContent).toContain(m.editor_read_only_strip());
  leave();
  expect(list()).toHaveLength(2);
});

it('stays mounted under a strip when its room refuses this person', async () => {
  docs.rooms = { status: 'unavailable' };
  await show();
  expect(host.textContent).toContain(m.editor_access_lost());
  leave();
  expect(list()).toHaveLength(1);
});
