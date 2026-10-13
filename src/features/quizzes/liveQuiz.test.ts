import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { pairedUndo } from '@/features/collaboration/undo';
import { LOCAL_EDIT } from '@/features/collaboration/yText';
import { exampleQuestions } from '@/features/questions/questionFixtures';
import type { Question } from '@/features/questions/types';
import {
  applyReaderMessage,
  itemParts,
  keysScope,
  readLearnerQuestions,
  readQuestions,
  seedQuiz,
  writeQuestion,
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
        {
          series: [
            {
              name: 'Vm',
              points: [
                [0, -70],
                [1, 30],
              ],
            },
          ],
          title: 'Potential',
          type: 'plot',
          xTitle: 'Time (ms)',
          yTitle: 'Vm (mV)',
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

it('gives learners no key, and matching and ordering only from the pushed lists', () => {
  const { content, keys } = quiz();
  // Without the room's lists a learner sees no ordering items at all: the
  // content document holds none (D3 as revised 2026-10-10).
  const bare = readLearnerQuestions(content);
  const orderingPart = bare.find((q) => q.parts[0].answer.type === 'ordering')
    ?.parts[0].answer;
  expect(orderingPart?.type === 'ordering' && orderingPart.items).toEqual([]);
  // The lists as the room pushes them (kind and texts, no ids).
  const lists = applyReaderMessage(new Map(), {
    full: true,
    parts: Object.fromEntries(
      itemParts(keys).map((part) => [
        part.part,
        { items: part.entries.map((entry) => entry.text), kind: part.kind },
      ])
    ),
  });
  const learner = readLearnerQuestions(content, lists);
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

it('moves an ordering item by its order key, keeping its entry', () => {
  const { content, keys } = quiz();
  const ordering = questions.find((q) => q.parts[0].answer.type === 'ordering');
  if (!ordering) throw new Error('ordering fixture');
  const items = () =>
    keysScope(keys).get(ordering.parts[0].id)?.get('items') as Y.Map<
      Y.Map<unknown>
    >;
  const entries = () =>
    [...items().entries()].map(([id, item]) => [
      item.get('text')?.toString(),
      id,
    ]);
  const held = new Map(entries().map(([text, id]) => [text, id]));
  const next = structuredClone(ordering);
  const answer = next.parts[0].answer;
  if (answer.type !== 'ordering') throw new Error('ordering fixture');
  answer.items = [answer.items[1], answer.items[0], answer.items[2]];
  writeQuestion(content, keys, next);
  expect(
    readQuestions(content, keys).find((q) => q.id === ordering.id)
  ).toEqual(next);
  for (const [text, id] of entries()) expect(id).toBe(held.get(text));
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
  expect(readQuestions(content, keys)[0]).toEqual(next);
  undo.undo();
  expect(readQuestions(content, keys)[0]).toEqual(questions[0]);
  expect(undo.canUndo()).toBe(false);
  undo.redo();
  expect(readQuestions(content, keys)[0]).toEqual(next);
});

it('applies pushed lists: a full one replaces, a partial one changes named parts', () => {
  const ordering = { items: ['b', 'a'], kind: 'ordering' as const };
  const matching = { items: ['x'], kind: 'matching' as const };
  let lists = applyReaderMessage(new Map(), {
    full: true,
    parts: { m: matching, o: ordering },
  });
  lists = applyReaderMessage(lists, {
    full: false,
    parts: { m: null, o: { items: ['a', 'c', 'b'], kind: 'ordering' } },
  });
  expect([...lists]).toEqual([
    ['o', { items: ['a', 'c', 'b'], kind: 'ordering' }],
  ]);
  lists = applyReaderMessage(lists, { full: true, parts: { m: matching } });
  expect([...lists.keys()]).toEqual(['m']);
});
