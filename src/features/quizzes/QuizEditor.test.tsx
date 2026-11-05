import { parseHTML } from 'linkedom';
import { act, useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { blankQuestion } from '@/features/questions/types';
import { getLocale, m } from '@/i18n';
import { readQuestions, seedQuiz, writeQuestion } from './liveQuiz';

/* A question added and left blank goes with the page, before its room does;
   one with anything in it stays. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const docs = vi.hoisted(() => ({
  atDestroy: -1,
  content: null as unknown as Y.Doc,
  keys: null as unknown as Y.Doc,
  rooms: {} as Record<string, unknown>,
}));
vi.mock('./liveQuizRooms', async (original) => ({
  ...(await original<typeof import('./liveQuizRooms')>()),
  useQuizRooms: () => {
    // As `useItemRoom`: the documents go in a passive effect's cleanup.
    useEffect(
      () => () => {
        docs.atDestroy = readQuestions(docs.content, docs.keys).length;
      },
      []
    );
    return {
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
    };
  },
}));
vi.mock('@/components/ui/ToolbarButton', () => ({
  ToolbarButton: ({
    label,
    onClick,
  }: {
    label: string;
    onClick: () => void;
  }) => <button aria-label={label} onClick={onClick} type="button" />,
}));
vi.mock('./QuestionPane', () => ({ QuestionPane: () => null }));
vi.mock('./QuizForm', () => ({
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
  docs.atDestroy = -1;
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

it('removes a blank added question as the page goes, before the room', async () => {
  await show();
  await addQuestion();
  expect(list()).toHaveLength(2);
  leave();
  expect(docs.atDestroy).toBe(1);
  expect(list()).toHaveLength(1);
});

it('keeps an added question someone wrote in', async () => {
  await show();
  await addQuestion();
  const added = list()[1];
  // A co-editor's edit, which this tab's pane never made.
  act(() =>
    writeQuestion(docs.content, docs.keys, {
      ...added,
      stem: [{ text: 'Typed in another tab.', type: 'text' }],
    })
  );
  leave();
  expect(list()).toHaveLength(2);
  expect(list()[1].stem[0]).toMatchObject({ text: 'Typed in another tab.' });
});

it('keeps an added question whose key someone wrote', async () => {
  await show();
  await addQuestion();
  const added = list()[1];
  const [part] = added.parts;
  act(() =>
    writeQuestion(docs.content, docs.keys, {
      ...added,
      parts: [{ ...part, answer: { accepted: ['Nucleus'], type: 'short' } }],
    })
  );
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
