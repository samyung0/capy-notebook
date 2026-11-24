import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Question } from '@/features/questions/types';
import { blankQuestion } from '@/features/questions/types';
import { getLocale } from '@/i18n';
import { figureRoom, seedQuiz, writeQuestion } from './liveQuiz';

/* Typing in the open card re-renders it alone: the closed cards keep their
   question objects and skip the render. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body></body></html>'
);
Object.assign(globalThis, {
  CSS: { escape: (value: string) => value },
  document,
  IS_REACT_ACT_ENVIRONMENT: true,
  window,
});

const renders = vi.hoisted(() => new Map<string, number>());
vi.mock('@/components/ui/Dialog', () => ({
  ConfirmDialog: () => null,
  useIsPhone: () => false,
}));
vi.mock('@/components/ui/ToolbarButton', () => ({ ToolbarButton: () => null }));
vi.mock('@/features/itemBanks/AddToBankItem', () => ({
  AddToBankItem: () => null,
}));
// Open and closed cards count their renders.
const counted = ({ question }: { question: Question }) => {
  renders.set(question.id, (renders.get(question.id) ?? 0) + 1);
  return null;
};
vi.mock('@/features/questions/QuestionCard', () => ({
  QuestionCard: counted,
  QuestionCardView: counted,
}));

const { createRoot } = await import('react-dom/client');
const { useQuizQuestions } = await import('./liveQuizRooms');
const { QuestionPane } = await import('./QuestionPane');

const content = new Y.Doc();
const keys = new Y.Doc();
const questions: Question[] = ['q1', 'q2', 'q3'].map((id) => ({
  ...blankQuestion(),
  id,
  stem: [{ text: id, type: 'text' }],
}));
seedQuiz(content, keys, questions);

function Pane() {
  const read = useQuizQuestions(content, keys);
  return (
    <QuestionPane
      figures={figureRoom({ content, keys })}
      onAdd={() => {}}
      onBank={() => {}}
      onDuplicate={() => {}}
      onMove={() => {}}
      // A new function each render, as the quiz page passes it.
      onOpen={() => {}}
      onRemove={() => {}}
      picked="q1"
      questions={read}
      quizId="qz_1"
      uploadAsset={async () => ({ assetId: 'a' })}
      uploadSample={async () => ({ board: 'b', image: 'i' })}
      write={(question) => {
        writeQuestion(content, keys, question);
        return true;
      }}
    />
  );
}

it('re-renders only the open card as its question is typed in', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Pane />));
  const before = new Map(renders);
  for (const text of ['q1 a', 'q1 ab'])
    act(() =>
      writeQuestion(content, keys, {
        ...questions[0],
        stem: [{ text, type: 'text' }],
      })
    );
  expect(renders.get('q1')).toBe((before.get('q1') ?? 0) + 2);
  expect(renders.get('q2')).toBe(before.get('q2'));
  expect(renders.get('q3')).toBe(before.get('q3'));
  act(() => root.unmount());
});
