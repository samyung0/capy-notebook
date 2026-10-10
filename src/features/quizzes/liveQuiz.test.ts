import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { pairedUndo } from '@/features/collaboration/undo';
import { LOCAL_EDIT } from '@/features/collaboration/yText';
import { exampleQuestions } from '@/features/questions/questionFixtures';
import type { Question } from '@/features/questions/types';
import {
  keysScope,
  readLearnerQuestions,
  readQuestions,
  seedQuiz,
  writeQuestion,
  writeReaderCopies,
} from './liveQuiz';

const rich: Question = {
  ...exampleQuestions[0],
  id: 'rich',
  parts: [
    {
      ...exampleQuestions[0].parts[0],
      blocks: [
        { label: 'Source A', text: 'Read $x^2$.', type: 'text' },
        {
          header: true,
          rows: [
            ['Cell', 'Size'],
            ['Red', '7 um'],
          ],
          type: 'table',
        },
        {
          description: 'A cell',
          height: 300,
          image: { assetId: 'asset_1' },
          type: 'image',
          width: 400,
        },
        {
          kind: 'bar',
          labels: ['a', 'b'],
          series: [{ name: 's', values: [1, 2.5] }],
          title: 'Sizes',
          type: 'chart',
        },
      ],
      id: 'rich-part',
    },
  ],
};
const questions = [...exampleQuestions, rich];

function quiz() {
  const content = new Y.Doc();
  const keys = new Y.Doc();
  seedQuiz(content, keys, questions);
  return { content, keys };
}

it('reads back what it was seeded with, keys and blocks included', () => {
  const { content, keys } = quiz();
  expect(readQuestions(content, keys)).toEqual(questions);
});

it('gives learners no key, and matching and ordering only from the reader copy', () => {
  const { content } = quiz();
  const learner = readLearnerQuestions(content);
  const text = JSON.stringify(learner);
  for (const secret of [
    'correct',
    'accepted',
    'markscheme',
    'solution',
    'pairs',
  ])
    expect(text).not.toContain(`"${secret}"`);
  const ordering = learner.find((q) => q.parts[0].answer.type === 'ordering');
  const answer = ordering?.parts[0].answer;
  expect(answer?.type === 'ordering' && [...answer.items].sort()).toEqual([
    'Golgi apparatus',
    'Ribosome',
    'Rough ER',
  ]);
  // The content document holds no key root at all.
  expect([...content.share.keys()]).toEqual(['questions']);
});

it('writes one typed character as one small change and keeps option ids', () => {
  const { content, keys } = quiz();
  const before = Y.encodeStateVector(content);
  const next = structuredClone(questions[0]);
  const answer = next.parts[0].answer;
  if (answer.type !== 'mcq') throw new Error('mcq fixture');
  answer.options[1] = 'Mitochondrion';
  const updates: Uint8Array[] = [];
  content.on('update', (update: Uint8Array) => updates.push(update));
  writeQuestion(content, keys, next);
  expect(readQuestions(content, keys)[0]).toEqual(next);
  const change = Y.encodeStateAsUpdate(content, before);
  expect(change.byteLength).toBeLessThan(80);
  expect(updates).toHaveLength(1);
});

it('moves an ordering item by its order key, keeping its slot', () => {
  const { content, keys } = quiz();
  const ordering = questions.find((q) => q.parts[0].answer.type === 'ordering');
  if (!ordering) throw new Error('ordering fixture');
  const items = () =>
    keysScope(keys).get(ordering.parts[0].id)?.get('items') as Y.Map<
      Y.Map<unknown>
    >;
  const slots = () =>
    [...items().values()].map((item) => [
      item.get('text')?.toString(),
      item.get('slot'),
    ]);
  const held = new Map(slots().map(([text, slot]) => [text, slot]));
  const next = structuredClone(ordering);
  const answer = next.parts[0].answer;
  if (answer.type !== 'ordering') throw new Error('ordering fixture');
  answer.items = [answer.items[1], answer.items[0], answer.items[2]];
  writeQuestion(content, keys, next);
  expect(
    readQuestions(content, keys).find((q) => q.id === ordering.id)
  ).toEqual(next);
  for (const [text, slot] of slots()) expect(slot).toBe(held.get(text));
});

it('merges two editors typing into different options', () => {
  const a = quiz();
  const b = { content: new Y.Doc(), keys: new Y.Doc() };
  Y.applyUpdate(b.content, Y.encodeStateAsUpdate(a.content));
  Y.applyUpdate(b.keys, Y.encodeStateAsUpdate(a.keys));
  const edit = (
    doc: { content: Y.Doc; keys: Y.Doc },
    index: number,
    suffix: string
  ) => {
    const next = structuredClone(readQuestions(doc.content, doc.keys)[0]);
    const answer = next.parts[0].answer;
    if (answer.type !== 'mcq') throw new Error('mcq fixture');
    answer.options[index] += suffix;
    writeQuestion(doc.content, doc.keys, next);
  };
  edit(a, 0, '!');
  edit(b, 2, '?');
  Y.applyUpdate(a.content, Y.encodeStateAsUpdate(b.content));
  Y.applyUpdate(b.content, Y.encodeStateAsUpdate(a.content));
  const merged = readQuestions(a.content, a.keys)[0].parts[0].answer;
  expect(merged.type === 'mcq' && merged.options).toEqual([
    'Nucleus!',
    'Mitochondria',
    'Ribosome?',
  ]);
  expect(readQuestions(b.content, b.keys)).toEqual(
    readQuestions(a.content, a.keys)
  );
});

it('undoes an answer type change in both documents as one step', () => {
  const { content, keys } = quiz();
  const undo = pairedUndo(
    new Y.UndoManager(content, { trackedOrigins: new Set([LOCAL_EDIT]) }),
    new Y.UndoManager(keys, { trackedOrigins: new Set([LOCAL_EDIT]) })
  );
  const next = structuredClone(questions[0]);
  next.parts[0].answer = { correct: false, type: 'boolean' };
  writeQuestion(content, keys, next);
  writeReaderCopies(content, keys, 'server');
  expect(readQuestions(content, keys)[0]).toEqual(next);
  undo.undo();
  expect(readQuestions(content, keys)[0]).toEqual(questions[0]);
  expect(undo.canUndo()).toBe(false);
  undo.redo();
  expect(readQuestions(content, keys)[0]).toEqual(next);
});
