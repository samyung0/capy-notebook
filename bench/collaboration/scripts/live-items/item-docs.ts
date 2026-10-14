/* Stored bytes of the live item documents (live-items DESIGN.md sections 1
 * and 8): a 50-question quiz (content and keys documents) and a 200-card
 * flashcard set built in the proposed shapes, then a scripted edit session.
 * Reports the JSON the projection writes, each document's GC'd state before
 * and after, and the update bytes per keystroke and per structural edit.
 *
 * node_modules/.bin/tsx bench/collaboration/scripts/live-items/item-docs.ts <out.json>
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type * as YT from 'yjs';
import { Y } from './load';

const { generateKeyBetween } = (await import(
  pathToFileURL(
    'C:/WEB/capy-notebook/node_modules/.pnpm/fractional-indexing@3.2.0/node_modules/fractional-indexing/src/index.js'
  ).href
)) as { generateKeyBetween(a: string | null, b: string | null): string };

let seed = 11;
const random = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
};
const WORDS =
  'cell membrane osmosis diffusion enzyme substrate active site energy glucose oxygen respiration mitochondria chloroplast light reaction carbon dioxide water rate temperature graph table value increase decrease explain why how which shows'.split(
    ' '
  );
const words = (chars: number) => {
  let out = '';
  while (out.length < chars) out += `${out ? ' ' : ''}${WORDS[random(WORDS.length)]}`;
  return out.slice(0, chars);
};
let ids = 0;
const id = (prefix: string) => `${prefix}_${(ids++).toString(36).padStart(6, '0')}`;

type Json = Record<string, unknown>;

/* ---------- Synthetic content in today's JSON question shape ---------- */

function question(): Json {
  const types = ['mcq', 'mcq', 'mcq', 'mcq', 'short', 'short', 'mcq', 'boolean', 'matching', 'ordering', 'open', 'gaps'];
  const partCount = random(10) < 7 ? 1 : 2 + random(2);
  const parts = Array.from({ length: partCount }, () => {
    const type = types[random(types.length)];
    const marks = type === 'open' ? 3 : 1 + random(2);
    const text = type === 'gaps' ? `${words(60)} (1) ______ ${words(40)} (2) ______.` : words(70 + random(60));
    const part: Json = { blocks: [{ text, type: 'text' }], id: id('p'), marks, solution: [{ text: words(150), type: 'text' }] };
    if (type === 'mcq')
      part.answer = { correct: random(3) === 0 ? [0, 2] : [random(4)], options: [0, 1, 2, 3].map(() => words(30)), type };
    else if (type === 'short') part.answer = { accepted: [words(10), words(12)], type };
    else if (type === 'boolean') part.answer = { correct: random(2) === 0, type };
    else if (type === 'matching')
      part.answer = {
        options: [0, 1, 2, 3, 4].map(() => words(20)),
        pairs: [0, 1, 2, 3].map((i) => ({ left: words(25), right: i })),
        type,
      };
    else if (type === 'ordering') part.answer = { items: [0, 1, 2, 3].map(() => words(30)), type };
    else if (type === 'open') {
      part.answer = { accepted: [words(200)], hints: [words(60)], type };
      part.markscheme = [0, 1, 2].map(() => ({ marks: 1, text: words(60) }));
    } else part.answer = { accepted: [[words(8)], [words(9), words(7)]], type };
    return part;
  });
  const stem: Json[] = [{ text: words(180), type: 'text' }];
  if (random(5) === 0)
    stem.push({ header: true, rows: [0, 1, 2].map(() => [words(8), words(8), words(8)]), type: 'table' });
  return { id: id('q'), labels: 'letters', layout: 'paper', parts, stem };
}

function card(): Json {
  const out: Json = { back: words(200), front: words(40), id: id('card') };
  if (random(5) === 0) out.image = { assetId: id('asset') };
  return out;
}

/* ---------- The proposed Yjs shapes (DESIGN.md section 1) ---------- */

const text = (value: string) => {
  const t = new Y.Text();
  t.insert(0, value);
  return t;
};
const map = (entries: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(entries)) m.set(key, value);
  return m;
};
/** Ids of the last collection built (a map not yet in a document cannot be read). */
let lastIds: string[] = [];

/** An ordered collection: id -> entry with an `order` key. */
function collection<T>(items: T[], build: (item: T) => YT.Map<unknown>, ordered = true) {
  const out = new Y.Map<YT.Map<unknown>>();
  let last: string | null = null;
  const made: string[] = [];
  for (const item of items) {
    const entry = build(item);
    if (ordered) {
      last = generateKeyBetween(last, null);
      entry.set('order', last);
    }
    const key = id('i');
    made.push(key);
    out.set(key, entry);
  }
  lastIds = made;
  return out;
}

function blockMap(block: Json): YT.Map<unknown> {
  if (block.type === 'text') return map({ text: text(block.text as string), type: 'text' });
  if (block.type === 'table') {
    const rows = block.rows as string[][];
    const columns = rows[0].map(() => id('col'));
    let last: string | null = null;
    return map({
      cells: map(
        Object.fromEntries(
          rows.flatMap((row, r) => row.map((cell, c) => [`${r}/${columns[c]}`, text(cell)]))
        )
      ),
      columns: map(
        Object.fromEntries(
          columns.map((column) => {
            last = generateKeyBetween(last, null);
            return [column, last];
          })
        )
      ),
      header: block.header,
      rows: map(Object.fromEntries(rows.map((_, r) => [String(r), generateKeyBetween(null, null) + r]))),
      type: 'table',
    });
  }
  return map({ type: block.type, value: block });
}

const textEntries = (values: string[], ordered = true) =>
  collection(values, (value) => map({ text: text(value) }), ordered);

/** Content (everyone who reads) and keys (editors only) for one part. */
function partMaps(part: Json): [YT.Map<unknown>, YT.Map<unknown>] {
  const answer = part.answer as Json;
  const type = answer.type as string;
  const content = map({ type });
  const keys = map({ type });
  if (type === 'mcq') {
    const options = textEntries(answer.options as string[]);
    content.set('options', options);
    const optionIds = lastIds;
    const correct = (answer.correct as number[]).map((i) => optionIds[i]);
    keys.set('correct', map(Object.fromEntries(correct.map((c) => [c, true]))));
  } else if (type === 'boolean') keys.set('correct', answer.correct);
  else if (type === 'short' || type === 'open') {
    keys.set('accepted', textEntries(answer.accepted as string[]));
    if (type === 'open') {
      keys.set('hints', textEntries(answer.hints as string[]));
      keys.set(
        'markscheme',
        collection(part.markscheme as Json[], (item) => map({ marks: item.marks, text: text(item.text as string) }))
      );
    }
  } else if (type === 'matching') {
    const options = textEntries(answer.options as string[], false);
    const optionIds = lastIds;
    const pairs = answer.pairs as { left: string; right: number }[];
    const left = textEntries(pairs.map((pair) => pair.left));
    const leftIds = lastIds;
    content.set('options', options);
    content.set('left', left);
    keys.set('pairs', map(Object.fromEntries(pairs.map((pair, i) => [leftIds[i], optionIds[pair.right]]))));
    let last: string | null = null;
    keys.set(
      'optionOrder',
      map(
        Object.fromEntries(
          optionIds.map((option) => {
            last = generateKeyBetween(last, null);
            return [option, last];
          })
        )
      )
    );
  } else if (type === 'ordering') {
    const items = textEntries(answer.items as string[], false);
    const itemIds = lastIds;
    content.set('items', items);
    let last: string | null = null;
    keys.set(
      'order',
      map(
        Object.fromEntries(
          itemIds.map((item) => {
            last = generateKeyBetween(last, null);
            return [item, last];
          })
        )
      )
    );
  } else if (type === 'gaps') {
    keys.set(
      'gaps',
      map(Object.fromEntries((answer.accepted as string[][]).map((list, i) => [String(i + 1), textEntries(list)])))
    );
  }
  keys.set('solution', collection(part.solution as Json[], blockMap));
  const partContent = map({
    answer: content,
    blocks: collection(part.blocks as Json[], blockMap),
    marks: part.marks,
  });
  return [partContent, keys];
}

function buildQuiz(questions: Json[]) {
  const contentDoc = new Y.Doc();
  const keysDoc = new Y.Doc();
  const qs = contentDoc.getMap<YT.Map<unknown>>('questions');
  const ks = keysDoc.getMap<YT.Map<unknown>>('parts');
  let last: string | null = null;
  contentDoc.transact(() =>
    keysDoc.transact(() => {
      for (const q of questions) {
        last = generateKeyBetween(last, null);
        const parts = new Y.Map<YT.Map<unknown>>();
        let partOrder: string | null = null;
        for (const part of q.parts as Json[]) {
          const [content, keys] = partMaps(part);
          partOrder = generateKeyBetween(partOrder, null);
          content.set('order', partOrder);
          parts.set(part.id as string, content);
          ks.set(part.id as string, keys);
        }
        qs.set(
          q.id as string,
          map({ labels: q.labels, layout: q.layout, order: last, parts, stem: collection(q.stem as Json[], blockMap) })
        );
      }
    })
  );
  return { contentDoc, keysDoc };
}

function buildSet(cards: Json[]) {
  const doc = new Y.Doc();
  const out = doc.getMap<YT.Map<unknown>>('cards');
  let last: string | null = null;
  doc.transact(() => {
    for (const c of cards) {
      last = generateKeyBetween(last, null);
      const entry = map({ back: text(c.back as string), front: text(c.front as string), order: last });
      if (c.image) entry.set('image', c.image);
      out.set(c.id as string, entry);
    }
  });
  return doc;
}

/* ---------- Measurement ---------- */

const stored = (doc: YT.Doc) => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return Y.encodeStateAsUpdate(copy).length;
};

function allTexts(root: YT.Map<YT.Map<unknown>>): YT.Text[] {
  const out: YT.Text[] = [];
  const walk = (value: unknown) => {
    if (value instanceof Y.Text) out.push(value);
    else if (value instanceof Y.Map) for (const child of value.values()) walk(child);
  };
  walk(root);
  return out;
}

function recorder(doc: YT.Doc) {
  const sizes: number[] = [];
  doc.on('update', (update: Uint8Array) => sizes.push(update.length));
  return sizes;
}

const mean = (values: number[]) => +(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)).toFixed(1);

function quizSession(contentDoc: YT.Doc, keysDoc: YT.Doc) {
  const qs = contentDoc.getMap<YT.Map<unknown>>('questions');
  const ks = keysDoc.getMap<YT.Map<unknown>>('parts');
  const sizes = { content: recorder(contentDoc), keys: recorder(keysDoc) };
  const typing: number[] = [];
  const structural: Record<string, number[]> = { addOption: [], addQuestion: [], correct: [], marks: [], move: [], removeQuestion: [], typeChange: [] };
  const measure = (bucket: number[], doc: 'content' | 'keys', run: () => void) => {
    const before = sizes[doc].length;
    run();
    for (const size of sizes[doc].slice(before)) bucket.push(size);
  };
  for (let step = 0; step < 1200; step++) {
    const texts = allTexts(qs);
    const t = texts[random(texts.length)];
    if (random(5) === 0 && t.length > 0) measure(typing, 'content', () => contentDoc.transact(() => t.delete(random(t.length), 1)));
    else measure(typing, 'content', () => contentDoc.transact(() => t.insert(random(t.length + 1), 'e')));
  }
  const questionIds = () => [...qs.keys()];
  for (let i = 0; i < 20; i++) {
    const q = qs.get(questionIds()[random(qs.size)])!;
    const part = [...(q.get('parts') as YT.Map<YT.Map<unknown>>).values()][0];
    const options = (part.get('answer') as YT.Map<unknown>).get('options') as YT.Map<YT.Map<unknown>> | undefined;
    if (!options) continue;
    const orders = [...options.values()].map((o) => o.get('order') as string).sort();
    measure(structural.addOption, 'content', () =>
      contentDoc.transact(() => options.set(id('i'), map({ order: generateKeyBetween(orders.at(-1) ?? null, null), text: text(words(25)) })))
    );
  }
  for (let i = 0; i < 10; i++) {
    const sorted = [...qs.values()].map((q) => q.get('order') as string).sort();
    const q = qs.get(questionIds()[random(qs.size)])!;
    const at = random(sorted.length - 1);
    measure(structural.move, 'content', () => contentDoc.transact(() => q.set('order', generateKeyBetween(sorted[at], sorted[at + 1]))));
  }
  for (let i = 0; i < 10; i++) {
    const q = qs.get(questionIds()[random(qs.size)])!;
    const part = [...(q.get('parts') as YT.Map<YT.Map<unknown>>).values()][0];
    measure(structural.marks, 'content', () => contentDoc.transact(() => part.set('marks', 1 + random(4))));
  }
  for (let i = 0; i < 10; i++) {
    const partId = [...ks.keys()][random(ks.size)];
    const keys = ks.get(partId)!;
    if (keys.get('type') !== 'mcq') continue;
    measure(structural.correct, 'keys', () => keysDoc.transact(() => keys.set('correct', id('i'))));
  }
  for (let i = 0; i < 5; i++) {
    const q = qs.get(questionIds()[random(qs.size)])!;
    const [partId, part] = [...(q.get('parts') as YT.Map<YT.Map<unknown>>).entries()][0];
    const [, keys] = partMaps({ answer: { accepted: [''], type: 'short' }, blocks: [], solution: [] });
    measure(structural.typeChange, 'content', () => contentDoc.transact(() => part.set('answer', map({ type: 'short' }))));
    measure(structural.typeChange, 'keys', () => keysDoc.transact(() => ks.set(partId, keys)));
  }
  for (let i = 0; i < 5; i++) {
    const q = question();
    measure(structural.addQuestion, 'content', () =>
      contentDoc.transact(() => {
        const parts = new Y.Map<YT.Map<unknown>>();
        for (const part of q.parts as Json[]) {
          const [content] = partMaps(part);
          parts.set(part.id as string, content);
        }
        qs.set(q.id as string, map({ labels: 'letters', layout: 'paper', order: generateKeyBetween(null, null), parts, stem: collection(q.stem as Json[], blockMap) }));
      })
    );
  }
  for (let i = 0; i < 3; i++)
    measure(structural.removeQuestion, 'content', () => contentDoc.transact(() => qs.delete(questionIds()[random(qs.size)])));
  return {
    keystrokes: typing.length,
    meanBytesPerKeystroke: mean(typing),
    structuralMeanBytes: Object.fromEntries(Object.entries(structural).map(([k, v]) => [k, { count: v.length, mean: mean(v) }])),
    totalUpdateBytes: { content: sizes.content.reduce((a, b) => a + b, 0), keys: sizes.keys.reduce((a, b) => a + b, 0) },
  };
}

function setSession(doc: YT.Doc) {
  const cards = doc.getMap<YT.Map<unknown>>('cards');
  const sizes = recorder(doc);
  const typing: number[] = [];
  const structural: Record<string, number[]> = { addCard: [], image: [], removeCard: [] };
  const measure = (bucket: number[], run: () => void) => {
    const before = sizes.length;
    run();
    for (const size of sizes.slice(before)) bucket.push(size);
  };
  for (let step = 0; step < 1200; step++) {
    const entry = [...cards.values()][random(cards.size)];
    const t = entry.get(random(4) === 0 ? 'front' : 'back') as YT.Text;
    if (random(5) === 0 && t.length > 0) measure(typing, () => doc.transact(() => t.delete(random(t.length), 1)));
    else measure(typing, () => doc.transact(() => t.insert(random(t.length + 1), 'e')));
  }
  for (let i = 0; i < 20; i++)
    measure(structural.addCard, () =>
      doc.transact(() => cards.set(id('card'), map({ back: text(words(120)), front: text(words(30)), order: generateKeyBetween(null, null) })))
    );
  for (let i = 0; i < 20; i++) measure(structural.removeCard, () => doc.transact(() => cards.delete([...cards.keys()][random(cards.size)])));
  for (let i = 0; i < 10; i++)
    measure(structural.image, () => doc.transact(() => [...cards.values()][random(cards.size)].set('image', { assetId: id('asset') })));
  return {
    keystrokes: typing.length,
    meanBytesPerKeystroke: mean(typing),
    structuralMeanBytes: Object.fromEntries(Object.entries(structural).map(([k, v]) => [k, { count: v.length, mean: mean(v) }])),
    totalUpdateBytes: sizes.reduce((a, b) => a + b, 0),
  };
}

/** The projection's question JSON size, read back from both documents. */
function quizJsonBytes(contentDoc: YT.Doc, keysDoc: YT.Doc) {
  return JSON.stringify({ content: contentDoc.getMap('questions').toJSON(), keys: keysDoc.getMap('parts').toJSON() }).length;
}

const questions = Array.from({ length: 50 }, question);
const cards = Array.from({ length: 200 }, card);
const quizJson = JSON.stringify(questions).length;
const setJson = JSON.stringify(cards).length;
const { contentDoc, keysDoc } = buildQuiz(questions);
const setDoc = buildSet(cards);
const before = { content: stored(contentDoc), keys: stored(keysDoc), set: stored(setDoc) };
const quiz = quizSession(contentDoc, keysDoc);
const set = setSession(setDoc);
const after = { content: stored(contentDoc), keys: stored(keysDoc), set: stored(setDoc) };
const report = {
  flashcards: {
    cards: 200,
    jsonBytesToday: setJson,
    jsonBytesAfterSession: JSON.stringify(setDoc.getMap('cards').toJSON()).length,
    session: set,
    storedBytesAfterSession: after.set,
    storedBytesFresh: before.set,
  },
  quiz: {
    jsonBytesAfterSession: quizJsonBytes(contentDoc, keysDoc),
    jsonBytesToday: quizJson,
    parts: questions.reduce((n, q) => n + (q.parts as Json[]).length, 0),
    questions: 50,
    session: quiz,
    storedBytesAfterSession: { content: after.content, keys: after.keys },
    storedBytesFresh: { content: before.content, keys: before.keys },
  },
};
writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
