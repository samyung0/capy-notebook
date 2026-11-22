import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { EMBED_CATALOG } from '@/api/embeds.generated';
import { itemUndo, pairedUndo } from '@/features/collaboration/undo';
import { LOCAL_EDIT } from '@/features/collaboration/yText';
import {
  exampleQuestion,
  exampleQuestions,
} from '@/features/questions/questionFixtures';
import type { Question, QuestionBlock } from '@/features/questions/types';
import { validateQuestion } from '@/features/questions/validation';
import { m } from '@/i18n';
import { ordered } from './liveMaps';
import {
  applyReaderMessage,
  insertQuestions,
  itemParts,
  keysScope,
  moveQuestion,
  questionsScope,
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
        { text: 'Read $x^2$.', type: 'text' },
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

it('keeps Multiple answer and gives learners checkboxes with one correct option', () => {
  const question = exampleQuestion('multiple', {
    correct: [1],
    multiple: true,
    options: ['Nucleus', 'Mitochondria', 'Ribosome'],
    type: 'mcq',
  });
  expect(validateQuestion(question)).toEqual(question);
  const content = new Y.Doc();
  const keys = new Y.Doc();
  seedQuiz(content, keys, [question]);
  expect(readQuestions(content, keys)).toEqual([question]);
  expect(readLearnerQuestions(content)[0].parts[0].answer).toMatchObject({
    multiple: true,
  });
});

it('keeps Shuffle options with its lock on its option and shuffles learners around it', () => {
  const question = exampleQuestion('shuffle', {
    correct: [1],
    locked: [3],
    options: ['Nucleus', 'Mitochondria', 'Ribosome', 'None of these'],
    shuffle: true,
    type: 'mcq',
  });
  expect(validateQuestion(question)).toEqual(question);
  const content = new Y.Doc();
  const keys = new Y.Doc();
  seedQuiz(content, keys, [question]);
  expect(readQuestions(content, keys)).toEqual([question]);
  const answer = readLearnerQuestions(content)[0].parts[0].answer;
  expect(answer.type === 'mcq' && answer.order?.[3]).toBe(3);
  expect(answer.type === 'mcq' && [...(answer.order ?? [])].sort()).toEqual([
    0, 1, 2, 3,
  ]);
  // The lock follows its option when the options move.
  const moved = structuredClone(question);
  const part = moved.parts[0];
  if (part.answer.type !== 'mcq') throw new Error('mcq');
  part.answer = {
    ...part.answer,
    correct: [2],
    locked: [0],
    options: ['None of these', 'Nucleus', 'Mitochondria', 'Ribosome'],
  };
  writeQuestion(content, keys, moved, 'parity');
  expect(readQuestions(content, keys)).toEqual([moved]);
  // Turning it off drops the locks.
  part.answer = { ...part.answer, locked: undefined, shuffle: undefined };
  writeQuestion(content, keys, moved, 'parity');
  expect(readQuestions(content, keys)[0].parts[0].answer).toEqual({
    correct: [2],
    options: ['None of these', 'Nucleus', 'Mitochondria', 'Ribosome'],
    type: 'mcq',
  });
});

// A learner's shuffled options keep the order already shown (the stored,
// server-seeded view) through every sync; one that no longer fits is seeded
// by the quiz and part, the same on each read.
it('keeps the shuffled order a learner already sees', () => {
  const question = exampleQuestion('shown', {
    correct: [1],
    locked: [3],
    options: ['Nucleus', 'Mitochondria', 'Ribosome', 'None of these'],
    shuffle: true,
    type: 'mcq',
  });
  const content = new Y.Doc();
  seedQuiz(content, new Y.Doc(), [question]);
  const partId = question.parts[0].id;
  const order = (shown?: number[]) => {
    const answer = readLearnerQuestions(content, undefined, {
      quizId: 'qz_1',
      shown: shown && new Map([[partId, shown]]),
    })[0].parts[0].answer;
    return answer.type === 'mcq' ? answer.order : undefined;
  };
  expect(order([2, 0, 1, 3])).toEqual([2, 0, 1, 3]);
  // The locked option out of place: seeded instead, stable.
  expect(order([3, 0, 1, 2])).toEqual(order());
  expect(order()).toEqual(order());
  expect(order()?.[3]).toBe(3);
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

it('inserts bank copies after the open question in the order picked, undone as one step', () => {
  const { content, keys } = quiz();
  const undo = pairedUndo(
    new Y.UndoManager(content, { trackedOrigins: new Set([LOCAL_EDIT]) }),
    new Y.UndoManager(keys, { trackedOrigins: new Set([LOCAL_EDIT]) })
  );
  const copy = (id: string): Question => ({
    ...structuredClone(questions[0]),
    id,
    parts: questions[0].parts.map((part, i) => ({ ...part, id: `${id}-${i}` })),
  });
  insertQuestions(content, keys, [copy('b1'), copy('b2')], 0);
  const ids = readQuestions(content, keys).map((question) => question.id);
  expect(ids).toEqual([
    questions[0].id,
    'b1',
    'b2',
    ...questions.slice(1).map((question) => question.id),
  ]);
  undo.undo();
  expect(readQuestions(content, keys)).toEqual(questions);
});

it('undoes only the latest edit when another document changed earlier', () => {
  // Rooms' managers, a second apart: the answer, then the stem twice. Yjs
  // reads the real clock, so each pause also ends its capture.
  vi.useFakeTimers();
  const { content, keys } = quiz();
  const managers = [itemUndo(content), itemUndo(keys)] as const;
  const undo = pairedUndo(...managers);
  const answered = structuredClone(questions[0]);
  const part = answered.parts[0];
  if (part.answer.type !== 'mcq') throw new Error('fixture is mcq');
  part.answer.correct = [part.answer.correct[0] === 0 ? 1 : 0];
  writeQuestion(content, keys, answered);
  const stem = (text: string) => {
    vi.advanceTimersByTime(1000);
    for (const manager of managers) manager.stopCapturing();
    const next = structuredClone(readQuestions(content, keys)[0]);
    next.stem = [{ text, type: 'text' }];
    writeQuestion(content, keys, next);
    return next;
  };
  const once = stem('First stem');
  stem('Second stem');
  undo.undo();
  expect(readQuestions(content, keys)[0]).toEqual(once);
  vi.useRealTimers();
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

/* The live quiz against the embed catalog (openwiki/embeds.md): every
   question block the catalog lists is written and read back, for editors and
   learners, and a block type the room holds but this reader does not know
   fails loudly instead of vanishing (and being deleted at the next save), as
   plot once did. */
function fixtureBlocks(name: string): QuestionBlock[] {
  const file = new URL(
    `../../../server/internal/questions/testdata/${name}.json`,
    import.meta.url
  );
  return JSON.parse(readFileSync(file, 'utf8')).question.stem;
}

it('writes and reads back every question block the embed catalog lists', () => {
  const samples = new Map(
    [...fixtureBlocks('rich-blocks'), ...fixtureBlocks('plot')].map((block) => [
      block.type as string,
      block,
    ])
  );
  const kinds = EMBED_CATALOG.embeds
    .filter((embed) => 'questionBlock' in embed && embed.questionBlock)
    .map((embed) => embed.kind);
  expect(kinds.length).toBeGreaterThan(0);
  const blocks = kinds.map((kind) => {
    const block = samples.get(kind);
    expect(block, `a ${kind} block in the shared fixtures`).toBeDefined();
    return block as QuestionBlock;
  });
  const question = { ...rich, id: 'catalog', stem: blocks };
  const content = new Y.Doc();
  const keys = new Y.Doc();
  seedQuiz(content, keys, [question]);
  expect(readQuestions(content, keys)[0].stem).toEqual(blocks);
  expect(readLearnerQuestions(content)[0].stem).toEqual(blocks);
  // Rewritten in place, as a save does.
  writeQuestion(content, keys, { ...question, stem: [...blocks].reverse() });
  expect(readQuestions(content, keys)[0].stem).toEqual([...blocks].reverse());
});

// A block of a kind this version has no reader for (its rooms are read-only,
// decision 5) shows as the unsupported notice in its place, for editors and
// learners, and no save writes over it or drops it.
it('shows a block type it has no reader for as the notice and never writes over it', () => {
  const { content, keys } = quiz();
  const question = questions[0];
  const stem = questionsScope(content).get(question.id)?.get('stem') as
    | Y.Map<Y.Map<unknown>>
    | undefined;
  expect(stem).toBeInstanceOf(Y.Map);
  const entry = new Y.Map<unknown>();
  stem?.set('b_future', entry);
  entry.set('order', 'a0');
  entry.set('type', 'timeline');
  const notice = { text: m.material_unsupported_block(), type: 'text' };
  expect(readQuestions(content, keys)[0].stem[0]).toEqual(notice);
  expect(readLearnerQuestions(content)[0].stem[0]).toEqual(notice);
  const edited = readQuestions(content, keys)[0];
  expect(() =>
    writeQuestion(content, keys, { ...edited, stem: edited.stem.slice(1) })
  ).toThrow('cannot edit');
  expect(stem?.get('b_future')?.get('type')).toBe('timeline');
});

/* Grouped parts (Epo 2026-11-04): the group and its figures merge entry by
   entry; what a merge leaves reads repaired. */
function groupedQuiz() {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        '../../../server/internal/questions/testdata/group-valid.json',
        import.meta.url
      ),
      'utf8'
    )
  ).question as Question;
  const content = new Y.Doc();
  const keys = new Y.Doc();
  seedQuiz(content, keys, [fixture]);
  return { content, fixture, keys };
}

/** A second editor's copy of the document. */
function copy(doc: Y.Doc) {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  return other;
}

const merge = (into: Y.Doc, from: Y.Doc) => {
  Y.applyUpdate(into, Y.encodeStateAsUpdate(from));
};

it('reads a grouped question back as written, for editors and learners', () => {
  const { content, fixture, keys } = groupedQuiz();
  expect(readQuestions(content, keys)[0]).toEqual(fixture);
  const learner = readLearnerQuestions(content)[0];
  expect(learner.groups).toEqual(fixture.groups);
  expect(learner.parts.map((part) => part.group)).toEqual(
    fixture.parts.map((part) => part.group)
  );
});

it('writes no groups map for a question with no group', () => {
  const { content, keys } = quiz();
  expect(questionsScope(content).get(questions[0].id)?.has('groups')).toBe(
    false
  );
  expect(readQuestions(content, keys)[0]).not.toHaveProperty('groups');
});

it('merges a group edit with a new sub-part, and writes only what differs', () => {
  const { content, fixture, keys } = groupedQuiz();
  const other = copy(content);
  const otherKeys = copy(keys);
  const [group] = fixture.groups ?? [];
  const added = { ...fixture.parts[1], id: 'part-b3' };
  writeQuestion(content, keys, {
    ...fixture,
    groups: [
      {
        ...group,
        blocks: [
          { text: 'Edited text.', type: 'text' },
          ...group.blocks.slice(1),
        ],
      },
    ],
  });
  writeQuestion(other, otherKeys, {
    ...fixture,
    parts: [
      fixture.parts[0],
      fixture.parts[1],
      fixture.parts[2],
      added,
      fixture.parts[3],
    ],
  });
  merge(content, other);
  merge(keys, otherKeys);
  const merged = readQuestions(content, keys)[0];
  expect(merged.groups?.[0].blocks[0]).toEqual({
    text: 'Edited text.',
    type: 'text',
  });
  expect(merged.groups?.[0].blocks.slice(1)).toEqual(group.blocks.slice(1));
  expect(merged.parts.map((part) => part.id)).toEqual([
    'part-a',
    'part-b1',
    'part-b2',
    'part-b3',
    'part-c',
  ]);
  expect(merged.parts[3].group).toBe('g1');
});

it('reads a sub-part whose group went as ungrouped', () => {
  const { content, fixture, keys } = groupedQuiz();
  const other = copy(content);
  const otherKeys = copy(keys);
  writeQuestion(content, keys, {
    ...fixture,
    parts: [
      fixture.parts[0],
      fixture.parts[1],
      fixture.parts[2],
      { ...fixture.parts[1], id: 'part-b3' },
      fixture.parts[3],
    ],
  });
  const { groups: _groups, ...withoutGroups } = fixture;
  writeQuestion(other, otherKeys, {
    ...withoutGroups,
    parts: [fixture.parts[0], fixture.parts[3]],
  });
  merge(content, other);
  merge(keys, otherKeys);
  const merged = readQuestions(content, keys)[0];
  expect(merged).not.toHaveProperty('groups');
  expect(merged.parts.map((part) => [part.id, part.group])).toEqual([
    ['part-a', undefined],
    ['part-b3', undefined],
    ['part-c', undefined],
  ]);
});

it("keeps a group's parts together when a merge separates them", () => {
  const { content, fixture, keys } = groupedQuiz();
  // One editor moves the group down while another reorders inside it: each
  // part's order merges by itself, which here splits the group.
  const parts = questionsScope(content)
    .get(fixture.id)
    ?.get('parts') as unknown as Y.Map<Y.Map<unknown>>;
  parts.get('part-b2')?.set('order', 'z9');
  const read = readQuestions(content, keys)[0];
  expect(read.parts.map((part) => part.id)).toEqual([
    'part-a',
    'part-b1',
    'part-b2',
    'part-c',
  ]);
  // Learners read it the same way, and the next write settles the keys.
  expect(readLearnerQuestions(content)[0].parts.map((part) => part.id)).toEqual(
    ['part-a', 'part-b1', 'part-b2', 'part-c']
  );
  writeQuestion(content, keys, read);
  const orders = read.parts.map((part) => parts.get(part.id)?.get('order'));
  expect([...orders].sort()).toEqual(orders);
});

it('reads a group with no parts as gone, and the next write takes it', () => {
  const { content, fixture, keys } = groupedQuiz();
  const parts = questionsScope(content)
    .get(fixture.id)
    ?.get('parts') as unknown as Y.Map<Y.Map<unknown>>;
  parts.delete('part-b1');
  parts.delete('part-b2');
  const read = readQuestions(content, keys)[0];
  expect(read).not.toHaveProperty('groups');
  expect(read.parts.map((part) => part.id)).toEqual(['part-a', 'part-c']);
  writeQuestion(content, keys, read);
  const held = questionsScope(content)
    .get(fixture.id)
    ?.get('groups') as Y.Map<unknown>;
  expect(held.size).toBe(0);
});

it("undoes a group's removal whole", () => {
  const { content, fixture, keys } = groupedQuiz();
  const undo = pairedUndo(
    new Y.UndoManager(content, { trackedOrigins: new Set([LOCAL_EDIT]) }),
    new Y.UndoManager(keys, { trackedOrigins: new Set([LOCAL_EDIT]) })
  );
  const { groups: _groups, ...withoutGroups } = fixture;
  writeQuestion(content, keys, {
    ...withoutGroups,
    parts: [fixture.parts[0], fixture.parts[3]],
  });
  expect(readQuestions(content, keys)[0]).not.toHaveProperty('groups');
  undo.undo();
  expect(readQuestions(content, keys)[0]).toEqual(fixture);
});

/* Two editors adding at the end at once give their entries one order key (a
   tie, read by id); a move or an insert between the two still lands there. */
function editors() {
  const a = quiz();
  const b = { content: copy(a.content), keys: copy(a.keys) };
  const sync = () => {
    for (const doc of ['content', 'keys'] as const) {
      merge(a[doc], b[doc]);
      merge(b[doc], a[doc]);
    }
  };
  return { a, b, sync };
}

/** The order keys of the last two entries in the list at `path`. */
function lastOrders(doc: Y.Doc, [root, ...path]: string[]) {
  let map = doc.getMap<unknown>(root);
  for (const key of path) map = map.get(key) as Y.Map<unknown>;
  return ordered(map)
    .slice(-2)
    .map((entry) => entry.order);
}

it('moves a question down one place re-keying only that question', () => {
  const { content } = quiz();
  const orders = () =>
    ordered(questionsScope(content) as Y.Map<unknown>).map(({ id, order }) => ({
      id,
      order,
    }));
  const [moved, ...others] = orders();
  moveQuestion(content, moved.id, 1);
  const now = orders();
  expect(now[1].id).toBe(moved.id);
  expect(now.filter(({ id }) => id !== moved.id)).toEqual(others);
});

it('moves a question between two that two editors added at once', () => {
  const { a, b, sync } = editors();
  writeQuestion(a.content, a.keys, exampleQuestion('tie-a'));
  writeQuestion(b.content, b.keys, exampleQuestion('tie-b'));
  sync();
  const tied = lastOrders(a.content, ['questions']);
  expect(tied).toHaveLength(2);
  expect(tied[0]).toBe(tied[1]);
  const [moved, ...rest] = questions.map((question) => question.id);
  moveQuestion(a.content, moved, rest.length + 1);
  expect(
    readQuestions(a.content, a.keys).map((question) => question.id)
  ).toEqual([...rest, 'tie-a', moved, 'tie-b']);
});

it('writes an option between two that two editors appended at once', () => {
  const { a, b, sync } = editors();
  const withOptions = (...options: string[]) => {
    const next = structuredClone(questions[0]);
    const answer = next.parts[0].answer;
    if (answer.type !== 'mcq') throw new Error('mcq fixture');
    answer.options.push(...options);
    return next;
  };
  writeQuestion(a.content, a.keys, withOptions('Golgi'));
  writeQuestion(b.content, b.keys, withOptions('Vacuole'));
  sync();
  const { id, parts } = questions[0];
  const path = ['questions', id, 'parts', parts[0].id, 'answer', 'options'];
  const tied = lastOrders(a.content, path);
  expect(tied).toHaveLength(2);
  expect(tied[0]).toBe(tied[1]);
  const answer = readQuestions(a.content, a.keys)[0].parts[0].answer;
  if (answer.type !== 'mcq') throw new Error('mcq fixture');
  const [first, second] = answer.options.slice(-2);
  const next = withOptions(first, 'Lysosome', second);
  writeQuestion(a.content, a.keys, next);
  expect(readQuestions(a.content, a.keys)[0]).toEqual(next);
});

it('writes a block between, or in place of, one of two stem blocks added at once', () => {
  const { a, b, sync } = editors();
  const withStem = (...stem: QuestionBlock[]) => ({ ...questions[0], stem });
  writeQuestion(a.content, a.keys, withStem({ text: 'From A', type: 'text' }));
  writeQuestion(b.content, b.keys, withStem({ text: 'From B', type: 'text' }));
  sync();
  const path = ['questions', questions[0].id, 'stem'];
  const tied = lastOrders(a.content, path);
  expect(tied).toHaveLength(2);
  expect(tied[0]).toBe(tied[1]);
  const [first, second] = readQuestions(a.content, a.keys)[0].stem;
  const between = withStem(first, { text: 'Between', type: 'text' }, second);
  writeQuestion(a.content, a.keys, between);
  expect(readQuestions(a.content, a.keys)[0]).toEqual(between);
  // Another type for the first starts a new entry, still read first.
  const replaced = withStem(
    { header: false, rows: [['x']], type: 'table' },
    second
  );
  writeQuestion(b.content, b.keys, replaced);
  expect(readQuestions(b.content, b.keys)[0]).toEqual(replaced);
});
