/*
 * Parity corpus for collaboration-rs/crates/notes: the Node collaboration
 * server's notes logic run on fixed inputs, its outputs recorded for the Rust
 * tests to compare exactly. Runs from a checkout's collaboration/src (see
 * README.md): it imports the server modules the way their own tests do.
 *
 * Every Y.Doc here has a fixed client id, so the recorded update bytes are
 * deterministic. Random sequences use a seeded generator.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  slateNodesToInsertDelta,
  withYjs,
  YjsEditor,
  yTextToSlateElement,
} from '@slate-yjs/core';
import type { Pool } from 'pg';
import {
  createEditor,
  type Descendant,
  Editor,
  Element,
  Node,
  type Path,
  Text,
  Transforms,
} from 'slate';
import * as Y from 'yjs';
import {
  applyChildren,
  childWrites,
  keptIds,
  planChildren,
} from './children.js';
import { applyCollaborationCommand } from './commands.js';
import {
  applyMaterialCommands,
  applyTextCommands,
  blockText,
  type DocumentCommand,
  EditError,
  type GuardTarget,
  inspectMaterial,
  verifyMaterialGuards,
  verifyTextGuards,
} from './editCommands.js';
import {
  MaterialDocumentLimitError,
  materialUpdateGrowth,
  measureMaterialValue,
} from './limits.js';
import { convertAgentMarkdown } from './markdown.js';
import { assertCanonicalMaterialValue } from './materialDocument.js';
import { UPDATE_UNHELD } from './officeRoots.js';
import { YjsDocumentStore } from './persistence.js';
import { type QuestionPolicy, validateQuestion } from './questions.js';

const OUT = process.env.CORPUS_OUT;
if (!OUT) throw new Error('CORPUS_OUT is required');
mkdirSync(OUT, { recursive: true });

/* ---------------------------------------------------------------- helpers */

const ZOD_MESSAGE = /^(invalid material document: )*\[/;
const LOW_SURROGATE = /[\uDC00-\uDFFF]/;
const HIGH_SURROGATE = /[\uD800-\uDBFF]/;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function write(name: string, data: unknown, gzip = false) {
  const json = JSON.stringify(data);
  const path = join(OUT as string, gzip ? `${name}.json.gz` : `${name}.json`);
  writeFileSync(path, gzip ? gzipSync(json, { level: 9 }) : `${json}\n`);
  // biome-ignore lint/suspicious/noConsole: the generator reports what it wrote.
  console.log(`${path}: ${(json.length / 1024).toFixed(0)} KiB json`);
}

/** Sorted-key JSON, numbers and strings as JSON.stringify writes them. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const hash = (value: unknown) =>
  createHash('sha256').update(canonical(value), 'utf8').digest('hex');

function newDoc(clientID: number) {
  const document = new Y.Doc({ gc: true });
  document.clientID = clientID;
  return document;
}

function docWithValue(value: unknown[], clientID = 1) {
  const document = newDoc(clientID);
  document
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(value as never));
  return document;
}

function docFromState(state: Uint8Array, clientID: number) {
  const document = newDoc(clientID);
  Y.applyUpdate(document, state);
  return document;
}

const plate = (document: Y.Doc) =>
  (
    yTextToSlateElement(document.get('content', Y.XmlText)) as {
      children: unknown[];
    }
  ).children;

function metricsOf(value: unknown[]) {
  try {
    return measureMaterialValue(value);
  } catch (error) {
    return { error: (error as Error).message };
  }
}

// mulberry32: a seeded generator, so a failure replays.
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Deterministic ids for every element that has none (fixtures carry none). */
function withIds(value: unknown[], prefix = 'b'): unknown[] {
  let next = 0;
  const visit = (node: Record<string, unknown>): Record<string, unknown> => {
    if (typeof node.text === 'string') return { ...node };
    const children = Array.isArray(node.children)
      ? (node.children as Record<string, unknown>[]).map(visit)
      : node.children;
    next += 1;
    return {
      ...node,
      children,
      id: typeof node.id === 'string' ? node.id : `${prefix}${next}`,
    };
  };
  return (value as Record<string, unknown>[]).map(visit);
}

/* --------------------------------------------------------------- fixtures */

const { buildBiologyLoadTestValue } = (await import(
  '../../src/mocks/noteContent/loadTest.ts'
)) as { buildBiologyLoadTestValue: () => unknown[] };
const { seedNotes } = (await import(
  '../../src/mocks/noteContent/index.ts'
)) as {
  seedNotes: { id: string; value: unknown[] }[];
};
const { embeddedSeeds } = (await import(
  '../../src/mocks/noteContent/helpers.ts'
)) as {
  embeddedSeeds: { block: unknown; id: string; kind: string }[];
};
const { biologyQuizQuestions } = (await import(
  '../../src/mocks/biologyQuiz.ts'
)) as { biologyQuizQuestions: unknown[] };

const loadNote = buildBiologyLoadTestValue();
const paragraph = (text: string, mark: Record<string, unknown> = {}) => ({
  children: [{ text, ...mark }],
  type: 'p',
});

/** Small hand-written notes: marks, inline elements, tables, nesting, voids. */
const smallNotes: Record<string, unknown[]> = {
  marks: [
    {
      children: [
        { text: 'plain ' },
        { bold: true, text: 'bold' },
        { bold: true, italic: true, text: ' both' },
        { italic: true, text: ' italic' },
        { code: true, text: ' code' },
        { color: '#ff0000', text: ' red' },
      ],
      id: 'm1',
      type: 'p',
    },
    {
      children: [
        { text: 'see ' },
        { children: [{ text: 'link' }], type: 'a', url: 'https://x.test' },
        { text: ' and ' },
        {
          children: [{ text: '' }],
          texExpression: 'x^2',
          type: 'inline_equation',
        },
        { text: '' },
      ],
      id: 'm2',
      type: 'p',
    },
  ],
  nested: [
    {
      children: [
        {
          children: [{ ...paragraph('deep quote'), id: 'n3' }],
          id: 'n2',
          type: 'blockquote',
        },
      ],
      id: 'n1',
      type: 'blockquote',
    },
    {
      children: [
        { children: [{ text: 'const x = 1;' }], type: 'code_line' },
        { children: [{ text: '' }], type: 'code_line' },
      ],
      id: 'n4',
      lang: 'ts',
      type: 'code_block',
    },
  ],
  table: [
    {
      children: [
        {
          children: [
            { children: [paragraph('a1')], type: 'td' },
            { children: [paragraph('b1')], type: 'td' },
          ],
          type: 'tr',
        },
        {
          children: [
            { children: [paragraph('a2', { bold: true })], type: 'td' },
            { children: [paragraph('')], type: 'td' },
          ],
          type: 'tr',
        },
      ],
      id: 't1',
      type: 'table',
    },
    { ...paragraph('after the table'), id: 't2' },
  ],
  voids: [
    {
      children: [{ text: '' }],
      id: 'v1',
      materialId: 'mat_q',
      refKind: 'quiz',
      type: 'material_ref',
    },
    {
      children: [{ text: '' }],
      id: 'v2',
      provider: 'youtube',
      type: 'video',
      videoId: 'dQw4w9WgXcQ',
    },
    {
      caption: 'Tangent',
      children: [{ text: '' }],
      html: '<p>"quoted" \\ back</p>',
      id: 'v3',
      type: 'html_embed',
    },
    { children: [{ text: 'x' }], id: 'v4', type: 'p' },
  ],
};

/* ------------------------------------------------------------- projection */

/** Edge cases built straight in Yjs, beyond what slate-yjs writes. */
function edgeStates(): { name: string; state: Uint8Array }[] {
  const out: { name: string; state: Uint8Array }[] = [];
  const add = (name: string, build: (root: Y.XmlText, doc: Y.Doc) => void) => {
    const doc = newDoc(7);
    build(doc.get('content', Y.XmlText), doc);
    out.push({ name, state: Y.encodeStateAsUpdate(doc) });
  };
  add('empty-root', () => {});
  add('empty-element', (root) => {
    root.insertEmbed(0, new Y.XmlText());
  });
  add('attribute-named-children-and-text', (root) => {
    const block = new Y.XmlText();
    root.insertEmbed(0, block);
    block.setAttribute('children', 'shadowed');
    block.setAttribute('type', 'p');
    block.insert(0, 'abc', { bold: true, text: 'shadowed' });
  });
  add('numbers-and-odd-values', (root) => {
    const block = new Y.XmlText();
    root.insertEmbed(0, block);
    block.setAttribute('type', 'p');
    block.setAttribute('big', 2 ** 40);
    block.setAttribute('neg', -0);
    block.setAttribute('tiny', 5e-7);
    block.setAttribute('huge', 1e21);
    block.setAttribute('frac', 0.1 + 0.2);
    block.setAttribute('nan', Number.NaN);
    block.setAttribute('inf', Number.POSITIVE_INFINITY);
    block.setAttribute('nil', null);
    block.setAttribute('undef', undefined);
    block.setAttribute('bool', false);
    block.setAttribute('arr', [1, 'two', null, { k: [3] }]);
    block.setAttribute('obj', { a: { nested: 'x' }, z: 1 });
    block.insert(0, 'ctl \u0001\u001f\b\f\n\r\t "q" \\ é 中 😀  ', {
      size: 12.5,
    });
  });
  add('format-churn', (root) => {
    const block = new Y.XmlText();
    root.insertEmbed(0, block);
    block.setAttribute('type', 'p');
    block.insert(0, 'abcdefghij');
    block.format(2, 5, { bold: true });
    block.format(3, 2, { italic: true });
    block.format(4, 4, { bold: null });
    block.format(0, 10, { color: 'red' });
    block.format(0, 3, { color: null });
    block.delete(4, 2);
    block.insert(1, 'X', { bold: true });
  });
  add('embed-with-formats', (root) => {
    const block = new Y.XmlText();
    root.insertEmbed(0, block);
    block.setAttribute('type', 'p');
    block.insert(0, 'ab', { bold: true });
    const inline = new Y.XmlText();
    block.insertEmbed(1, inline, { bold: true });
    inline.setAttribute('type', 'a');
    inline.insert(0, 'link');
    block.insert(3, '', { italic: true });
  });
  add('deleted-and-gc', (root, doc) => {
    for (let i = 0; i < 5; i += 1) {
      const block = new Y.XmlText();
      root.insertEmbed(i, block);
      block.setAttribute('type', 'p');
      block.insert(0, `block ${i}`, i % 2 ? { bold: true } : {});
    }
    root.delete(1, 2);
    const kept = root.toDelta()[0].insert as Y.XmlText;
    kept.delete(0, 3);
    kept.setAttribute('type', 'h1');
    kept.removeAttribute('type');
    void doc;
  });
  add('surrogate-split', (root) => {
    const block = new Y.XmlText();
    root.insertEmbed(0, block);
    block.setAttribute('type', 'p');
    block.insert(0, 'a😀b');
    block.insert(2, 'X'); // inside the pair: both halves become U+FFFD
  });
  return out;
}

function projectionFamily(extra: { name: string; state: Uint8Array }[]) {
  const states: { name: string; state: Uint8Array }[] = [
    { name: 'load-note', state: Y.encodeStateAsUpdate(docWithValue(loadNote)) },
    ...seedNotes.map((note) => ({
      name: `seed-${note.id}`,
      state: Y.encodeStateAsUpdate(docWithValue(note.value)),
    })),
    ...Object.entries(smallNotes).map(([name, value]) => ({
      name: `small-${name}`,
      state: Y.encodeStateAsUpdate(docWithValue(value)),
    })),
    ...edgeStates(),
    ...extra,
  ];
  const cases = states.map(({ name, state }) => {
    const value = plate(docFromState(state, 99));
    const big = state.length > 64 * 1024;
    return {
      hash: hash(value),
      metrics: metricsOf(value),
      name,
      state: b64(state),
      // The two-MiB values only by hash.
      value: big ? null : value,
    };
  });
  write('projection', cases, true);
}

/* -------------------------------------------------------- random Slate ops */

const INLINE_TYPES = new Set(['a', 'inline_equation', 'mention']);

/**
 * A Slate editor on its own copy of the room, as a browser holds one (the
 * plate track's property-test client, with recording). Each step runs one
 * random Slate transform and returns the Slate operations slate-yjs flushed
 * and the Yjs update they made.
 */
function slateClient(
  room: Y.Doc,
  clientID: number,
  random: () => number,
  big: boolean
) {
  const document = docFromState(Y.encodeStateAsUpdate(room), clientID);
  const pending: Uint8Array[] = [];
  document.on('update', (update: Uint8Array) => pending.push(update));
  const editor = withYjs(createEditor(), document.get('content', Y.XmlText));
  editor.isInline = (element) =>
    INLINE_TYPES.has((element as { type?: string }).type ?? '');
  YjsEditor.connect(editor);

  const pick = <T>(list: readonly T[]) =>
    list[Math.floor(random() * list.length)];
  const count = (max: number) => 1 + Math.floor(random() * max);
  const characters = [
    'a',
    'b',
    ' ',
    'é',
    '中',
    '😀',
    '"',
    '\\',
    '\n',
    '\u0001',
  ];
  const word = (length: number) =>
    Array.from({ length }, () => pick(characters)).join('');
  const texts = () =>
    Array.from(
      Editor.nodes(editor, { at: [], match: Text.isText }),
      ([, path]) => path
    );
  // Offsets never split a surrogate pair: a browser's Slate moves by
  // grapheme, and a Rust string cannot hold half a pair.
  const offsetIn = (text: string) => {
    let offset = Math.floor(random() * (text.length + 1));
    const code = text.charCodeAt(offset - 1);
    if (code >= 0xd8_00 && code <= 0xdb_ff) offset -= 1;
    return offset;
  };
  const point = (path = pick(texts())) => ({
    offset: offsetIn((Node.get(editor, path) as Text).text),
    path,
  });
  const range = () => {
    const path = pick(texts());
    return { anchor: point(path), focus: point(path) };
  };
  const block = (): Path => [Math.floor(random() * editor.children.length)];
  const marks = [
    { bold: true },
    { italic: true },
    { code: true },
    { color: '#ff0000' },
    { backgroundColor: 'rgb(255, 240, 200)' },
    { comment_thread: true },
    { bold: true, italic: true },
  ];
  const para = (text: string, mark = {}) => ({
    children: [{ text, ...mark }],
    type: 'p',
  });
  const nested = (depth: number): Descendant => {
    let node: Record<string, unknown> = para(word(4));
    for (let level = 0; level < depth; level += 1)
      node = { children: [node], type: 'blockquote' };
    return node as unknown as Descendant;
  };
  const table = (rows: number, columns: number) => ({
    children: Array.from({ length: rows }, () => ({
      children: Array.from({ length: columns }, () => ({
        children: [para(word(3))],
        type: 'td',
      })),
      type: 'tr',
    })),
    type: 'table',
  });
  const blocks = (): Descendant[] =>
    pick([
      () => [para(word(count(200)))],
      () => [para('x'.repeat(count(big ? 30_000 : 300)), pick(marks))],
      () => [
        {
          children: [
            { text: word(5) },
            { bold: true, text: word(5) },
            {
              children: [{ text: word(3) }],
              type: 'a',
              url: 'https://example.com',
            },
            { color: '#00f', text: word(5) },
          ],
          id: word(6),
          type: 'p',
        },
      ],
      () => [table(count(6), count(6))],
      () => [nested(count(20))],
      () => Array.from({ length: count(20) }, () => para(word(count(40)))),
      () => [
        {
          block: {
            kind: 'bar',
            labels: ['A'],
            series: [{ name: 'S', values: [1.5] }],
            title: 'T',
            type: 'chart',
          },
          children: [{ text: '' }],
          id: word(4),
          type: 'chart',
        },
      ],
    ])() as Descendant[];
  const isBlock = (node: Node) =>
    Element.isElement(node) && Editor.isBlock(editor, node);
  const operations = [
    () => Transforms.insertText(editor, word(count(3)), { at: point() }),
    () => Transforms.insertText(editor, word(count(3)), { at: point() }),
    () => Transforms.insertText(editor, word(count(3)), { at: point() }),
    () =>
      Transforms.delete(editor, {
        at: point(),
        distance: count(40),
        unit: 'character',
      }),
    () =>
      Transforms.delete(editor, {
        at: { anchor: point(), focus: point() },
      }),
    () =>
      Transforms.splitNodes(editor, {
        always: true,
        at: point(),
        match: isBlock,
      }),
    () => {
      const at = block();
      if (at[0] > 0) Transforms.mergeNodes(editor, { at });
    },
    () =>
      Transforms.setNodes(editor, pick(marks) as Partial<Node>, {
        at: range(),
        match: Text.isText,
        split: true,
      }),
    () =>
      Transforms.unsetNodes(editor, Object.keys(pick(marks)), {
        at: range(),
        match: Text.isText,
        split: true,
      }),
    () =>
      Transforms.setNodes(
        editor,
        pick([
          { type: 'h2' },
          { indent: count(4), listStyleType: 'disc' },
          { checked: true },
          { align: 'center' },
          { id: word(count(30)) },
          { meta: { a: 1, b: [true, null] } },
        ]) as Partial<Node>,
        { at: block() }
      ),
    () =>
      Transforms.unsetNodes(editor, ['indent', 'listStyleType', 'align'], {
        at: block(),
      }),
    () => Transforms.insertNodes(editor, blocks(), { at: block() }),
    () => Transforms.insertNodes(editor, blocks(), { at: block() }),
    () =>
      Transforms.insertNodes(
        editor,
        [para('y'.repeat(count(big ? 60_000 : 600)))],
        {
          at: block(),
        }
      ),
    () => Transforms.removeNodes(editor, { at: block() }),
    () =>
      Transforms.wrapNodes(
        editor,
        { children: [], type: 'blockquote' } as unknown as Element,
        { at: block() }
      ),
    () => {
      const at = block();
      const node = Node.get(editor, at) as Element;
      if (Element.isElement(node.children[0]))
        Transforms.unwrapNodes(editor, { at });
    },
    () => Transforms.moveNodes(editor, { at: block(), to: block() }),
    () =>
      Transforms.wrapNodes(
        editor,
        {
          children: [],
          type: 'a',
          url: `https://example.com/${word(8)}`,
        } as unknown as Element,
        { at: range(), split: true }
      ),
  ];

  return {
    close() {
      YjsEditor.disconnect(editor);
    },
    document,
    step() {
      try {
        pick(operations)();
      } catch {
        // An operation Slate refuses at that spot; whatever it applied stays.
      }
      const ops = YjsEditor.localChanges(editor).map(({ op }) => op);
      YjsEditor.flushLocalChanges(editor);
      const update = pending.length > 0 ? Y.mergeUpdates(pending) : null;
      if (pending.length > 1) throw new Error('one transaction per flush');
      pending.length = 0;
      return { ops, update, value: editor.children };
    },
  };
}

// Hocuspocus applies a client's update under this origin.
const connection = { source: 'connection' };
const ROOM_CLIENT = 1000;

/** Counts the exact path of validateUpdate: it destroys its candidate copy. */
let scratchDestroys = 0;
const destroy = Y.Doc.prototype.destroy;
Y.Doc.prototype.destroy = function (this: Y.Doc) {
  if (this.guid === 'scratch') scratchDestroys += 1;
  return destroy.call(this);
};

interface OpsOptions {
  name: string;
  /** A second writer whose updates the Rust side applies as bytes. */
  peer?: boolean;
  seed: number;
  steps: number;
  /** Steps between peers reopening on the room. */
  syncEvery?: number;
  value: unknown[];
  /** Keep full values in the record (small documents). */
  values?: boolean;
}

function opsFamily(options: OpsOptions) {
  const random = seeded(options.seed);
  const room = docWithValue(options.value, ROOM_CLIENT);
  const initial = Y.encodeStateAsUpdate(room);
  const store = new YjsDocumentStore({} as Pool);
  const roomName = `material:${options.name}:schema:1`;
  const roomUpdates: Uint8Array[] = [];
  room.on('update', (update: Uint8Array) => roomUpdates.push(update));
  let nextClient = 2000;
  const big = !options.values;
  const open = () => slateClient(room, nextClient++, random, big);
  let writer = open();
  let peer = options.peer ? open() : null;
  const steps: unknown[] = [];
  for (let index = 0; index < options.steps; index += 1) {
    const usePeer = peer !== null && random() < 0.3;
    const client = usePeer && peer ? peer : writer;
    const before = { client: client.document.clientID };
    const { ops, update } = client.step();
    const record: Record<string, unknown> = {
      ...before,
      peer: usePeer,
      ...(usePeer ? {} : { ops }),
      update: update ? b64(update) : null,
    };
    if (!usePeer) {
      const value = plate(client.document);
      record.clientHash = hash(value);
      if (options.values) record.clientValue = value;
    }
    if (update) {
      const content = room.get('content', Y.XmlText);
      record.growth = materialUpdateGrowth(content, update);
      const destroysBefore = scratchDestroys;
      let outcome: Record<string, unknown>;
      try {
        const result = store.validateUpdate(roomName, room, update);
        outcome =
          result === UPDATE_UNHELD ? { unheld: true } : { accepted: true };
      } catch (error) {
        outcome =
          error instanceof MaterialDocumentLimitError
            ? { code: error.code, metrics: error.metrics, refused: true }
            : { error: (error as Error).message, refused: true };
      }
      outcome.exact = scratchDestroys > destroysBefore;
      record.outcome = outcome;
      if (outcome.accepted) {
        roomUpdates.length = 0;
        Y.applyUpdate(room, update, connection);
        // The update itself, then Yjs's own format cleanup, if any.
        record.roomCleanup = roomUpdates.slice(1).map(b64);
        const value = plate(room);
        record.roomMetrics = metricsOf(value);
        record.roomHash = hash(value);
        if (options.values) record.roomValue = value;
      } else if (outcome.refused) {
        // The writer drops its document and reopens on the room.
        client.close();
        if (usePeer) peer = open();
        else writer = open();
        record.reopened = true;
      }
    }
    if (
      options.syncEvery &&
      index % options.syncEvery === options.syncEvery - 1
    ) {
      writer.close();
      writer = open();
      if (peer) {
        peer.close();
        peer = open();
      }
      record.synced = true;
    }
    steps.push(record);
  }
  writer.close();
  peer?.close();
  write(
    `ops-${options.name}`,
    {
      initial: b64(initial),
      name: options.name,
      roomClient: ROOM_CLIENT,
      steps,
    },
    true
  );
  return {
    name: `ops-final-${options.name}`,
    state: Y.encodeStateAsUpdate(room),
  };
}

/* ------------------------------------------------------------ multi-writer */

/**
 * Three Slate clients on stale copies of one room (plate REVIEW1 M3, after
 * the reviewer's twopeer probe): they edit, pull the room as remote events,
 * and deliver their queued updates merged or one by one. Each delivered
 * update is checked by the room's validator, as Hocuspocus would.
 */
function multiWriterFamily(seed: number, steps: number) {
  const random = seeded(seed);
  const pick = <T>(list: readonly T[]) =>
    list[Math.floor(random() * list.length)];
  const count = (max: number) => 1 + Math.floor(random() * max);
  const characters = ['a', 'b', ' ', 'e', '😀', '"', '\\', '\u0001', '中'];
  const word = (length: number) =>
    Array.from({ length }, () => pick(characters)).join('');
  const marks = [
    { bold: true },
    { italic: true },
    { code: true },
    { color: '#ff0000' },
    { backgroundColor: 'rgb(1, 2, 3)' },
  ];
  const para = (text: string, mark = {}) => ({
    children: [{ text, ...mark }],
    type: 'p',
  });
  const initial = Array.from({ length: 12 }, () => ({
    children: [
      { text: word(10) },
      { bold: true, text: word(8) },
      { text: word(6) },
      { color: '#00f', italic: true, text: word(5) },
      { text: word(4) },
    ],
    type: 'p',
  }));
  const room = docWithValue(initial, ROOM_CLIENT);
  const start = Y.encodeStateAsUpdate(room);
  const store = new YjsDocumentStore({} as Pool);
  const roomName = `material:multi-${seed}:schema:1`;
  const roomUpdates: Uint8Array[] = [];
  room.on('update', (update: Uint8Array) => roomUpdates.push(update));
  let nextClient = 3000;
  const client = () => {
    const doc = docFromState(Y.encodeStateAsUpdate(room), nextClient++);
    const queue: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') queue.push(update);
    });
    const editor = withYjs(createEditor(), doc.get('content', Y.XmlText));
    YjsEditor.connect(editor);
    const texts = () =>
      Array.from(
        Editor.nodes(editor, { at: [], match: Text.isText }),
        ([, path]) => path
      );
    const point = (path = pick(texts())) => ({
      offset: Math.floor(
        random() * ((Node.get(editor, path) as Text).text.length + 1)
      ),
      path,
    });
    const range = () => ({ anchor: point(), focus: point() });
    const block = (): Path => [Math.floor(random() * editor.children.length)];
    const isBlock = (node: Node) =>
      Element.isElement(node) && Editor.isBlock(editor, node);
    const operations = [
      () => Transforms.insertText(editor, word(count(3)), { at: point() }),
      () => Transforms.insertText(editor, word(count(3)), { at: point() }),
      () =>
        Transforms.delete(editor, {
          at: point(),
          distance: count(20),
          unit: 'character',
        }),
      () => Transforms.delete(editor, { at: range() }),
      () =>
        Transforms.splitNodes(editor, {
          always: true,
          at: point(),
          match: isBlock,
        }),
      () => {
        const at = block();
        if (at[0] > 0) Transforms.mergeNodes(editor, { at });
      },
      () =>
        Transforms.setNodes(editor, pick(marks) as Partial<Node>, {
          at: range(),
          match: Text.isText,
          split: true,
        }),
      () =>
        Transforms.setNodes(editor, pick(marks) as Partial<Node>, {
          at: range(),
          match: Text.isText,
          split: true,
        }),
      () =>
        Transforms.unsetNodes(editor, Object.keys(pick(marks)), {
          at: range(),
          match: Text.isText,
          split: true,
        }),
      () =>
        Transforms.setNodes(
          editor,
          pick([
            { type: 'h2' },
            { align: 'center' },
            { id: word(5) },
          ]) as Partial<Node>,
          { at: block() }
        ),
      () =>
        Transforms.insertNodes(
          editor,
          [para(word(count(30)), pick(marks))] as never,
          { at: block() }
        ),
      () =>
        Transforms.wrapNodes(
          editor,
          { children: [], type: 'blockquote' } as never,
          { at: block() }
        ),
      () => Transforms.moveNodes(editor, { at: block(), to: block() }),
      () => Transforms.removeNodes(editor, { at: block() }),
    ];
    return {
      pull() {
        try {
          Y.applyUpdate(
            doc,
            Y.encodeStateAsUpdate(room, Y.encodeStateVector(doc)),
            'remote'
          );
        } catch {
          // A remote event slate-yjs cannot map; the client keeps its document.
        }
      },
      queue,
      step() {
        try {
          pick(operations)();
          YjsEditor.flushLocalChanges(editor);
        } catch {
          // Refused by Slate at that spot.
        }
      },
    };
  };
  const peers = [client(), client(), client()];
  const deliveries: unknown[] = [];
  for (let index = 0; index < steps; index += 1) {
    const peer = pick(peers);
    const roll = random();
    if (roll < 0.55) peer.step();
    else if (roll < 0.85 && peer.queue.length) {
      const updates =
        random() < 0.5 ? [Y.mergeUpdates(peer.queue)] : [...peer.queue];
      peer.queue.length = 0;
      for (const update of updates) {
        const content = room.get('content', Y.XmlText);
        const record: Record<string, unknown> = {
          growth: materialUpdateGrowth(content, update),
          update: b64(update),
        };
        const destroysBefore = scratchDestroys;
        let outcome: Record<string, unknown>;
        try {
          const result = store.validateUpdate(roomName, room, update);
          outcome =
            result === UPDATE_UNHELD ? { unheld: true } : { accepted: true };
        } catch (error) {
          outcome =
            error instanceof MaterialDocumentLimitError
              ? { code: error.code, metrics: error.metrics, refused: true }
              : { error: (error as Error).message, refused: true };
        }
        outcome.exact = scratchDestroys > destroysBefore;
        record.outcome = outcome;
        if (outcome.accepted) {
          roomUpdates.length = 0;
          Y.applyUpdate(room, update, connection);
          record.roomCleanup = roomUpdates.slice(1).map(b64);
          const value = plate(room);
          record.roomMetrics = metricsOf(value);
          record.roomHash = hash(value);
        }
        deliveries.push(record);
      }
    } else peer.pull();
  }
  write(
    `multi-${seed}`,
    { deliveries, initial: b64(start), roomClient: ROOM_CLIENT },
    true
  );
}

/* ------------------------------------------------------------- validation */

const QUESTION_FIXTURES = fileURLToPath(
  new URL('../../server/internal/questions/testdata/', import.meta.url)
);
const BANK_HOST = 'https://bank.example/assets';

/** A thrown validation's message, and whether zod raised it (zod's message
 * is its issue list as JSON, which the Rust port does not reproduce). */
function outcome(run: () => unknown): Record<string, unknown> {
  try {
    run();
    return { ok: true };
  } catch (error) {
    const message = (error as Error).message;
    return {
      message,
      ok: false,
      zod: ZOD_MESSAGE.test(message),
    };
  }
}

function withEnv<T>(host: string | null, run: () => T): T {
  const previous = process.env.BANK_ASSETS_URL;
  if (host === null) delete process.env.BANK_ASSETS_URL;
  else process.env.BANK_ASSETS_URL = host;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.BANK_ASSETS_URL;
    else process.env.BANK_ASSETS_URL = previous;
  }
}

/** Random structural damage to a Plate value, for pass/fail parity. */
function mutate(value: unknown[], random: () => number): unknown[] {
  const copy = structuredClone(value) as Record<string, unknown>[];
  const nodes: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    nodes.push(node as Record<string, unknown>);
    const record = node as Record<string, unknown>;
    for (const child of Object.values(record))
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === 'object') walk(child);
  };
  copy.forEach(walk);
  const pick = <T>(list: readonly T[]) =>
    list[Math.floor(random() * list.length)];
  const values = [
    null,
    0,
    -1,
    1.5,
    '',
    ' ',
    'x',
    'é😀',
    true,
    [],
    {},
    [{ text: '' }],
    'x'.repeat(13_000),
    'quiz',
    'flashcards',
    'material_ref',
    'chart',
    'graph',
    'p',
    'https://bank.example/assets/a.png',
    'https://evil.example/a.png',
  ];
  const steps = 1 + Math.floor(random() * 3);
  for (let i = 0; i < steps; i += 1) {
    const node = pick(nodes);
    if (!node) break;
    const keys = Object.keys(node);
    const roll = random();
    if (roll < 0.3 && keys.length) delete node[pick(keys)];
    else if (roll < 0.6 && keys.length) node[pick(keys)] = pick(values);
    else if (roll < 0.7)
      node[
        pick([
          'suggestion',
          'suggestion_x',
          'questions',
          'cards',
          'code',
          'timeLimitMin',
          'extra',
          'pending',
          'src',
          'children',
          'text',
        ])
      ] = pick(values);
    else if (roll < 0.8 && Array.isArray(node.children) && node.children.length)
      (node.children as unknown[]).push(
        structuredClone(pick(node.children as unknown[]))
      );
    else if (roll < 0.9) copy.push(structuredClone(pick(copy)));
    else
      copy.splice(Math.floor(random() * copy.length), 0, {
        children: [structuredClone(pick(copy))],
        id: `wrap${i}`,
        type: 'callout',
      });
  }
  return copy;
}

function validationFamily() {
  const random = seeded(11);
  const questionCases: unknown[] = [];
  for (const file of readdirSync(QUESTION_FIXTURES).filter((name) =>
    name.endsWith('.json')
  )) {
    const fixture = JSON.parse(
      readFileSync(`${QUESTION_FIXTURES}${file}`, 'utf8')
    ) as { policy: QuestionPolicy; question: unknown; valid: boolean };
    for (const host of [null, BANK_HOST]) {
      questionCases.push({
        file,
        host,
        outcome: withEnv(host, () =>
          outcome(() => validateQuestion(fixture.question, fixture.policy))
        ),
        policy: fixture.policy,
        question: fixture.question,
        valid: fixture.valid,
      });
    }
  }

  const quizOf = (question: unknown, id = 'quiz1') => [
    {
      children: [
        {
          children: [{ text: '' }],
          id: (question as { id: string }).id,
          question,
          type: 'quiz_question',
        },
      ],
      id,
      type: 'quiz',
    },
  ];
  const fixtureQuestions = readdirSync(QUESTION_FIXTURES)
    .filter((name) => name.endsWith('.json'))
    .map(
      (name) =>
        JSON.parse(readFileSync(`${QUESTION_FIXTURES}${name}`, 'utf8')) as {
          question: { stem?: unknown[] };
          valid: boolean;
        }
    );
  const richStem = fixtureQuestions.find(
    (fixture) => fixture.question.stem?.length
  )?.question.stem as Record<string, unknown>[];
  const bases: { kind: string; name: string; value: unknown[] }[] = [
    ...seedNotes.map((note) => ({
      kind: 'note',
      name: note.id,
      value: withIds(note.value),
    })),
    { kind: 'note', name: 'load-note', value: withIds(loadNote) },
    ...Object.entries(smallNotes).map(([name, value]) => ({
      kind: 'note',
      name,
      value: withIds(value),
    })),
    ...embeddedSeeds.map((seed) => ({
      kind: seed.kind,
      name: seed.id,
      value: withIds([seed.block]),
    })),
    ...fixtureQuestions
      .filter((fixture) => fixture.valid)
      .map((fixture, index) => ({
        kind: 'quiz',
        name: `fixture-quiz-${index}`,
        value: quizOf(fixture.question),
      })),
    ...biologyQuizQuestions.map((question, index) => ({
      kind: 'quiz',
      name: `biology-quiz-${index}`,
      value: quizOf(question),
    })),
    ...richStem
      .filter((block) => block.type === 'chart' || block.type === 'graph')
      .map((block, index) => ({
        kind: 'note',
        name: `embed-${index}`,
        value: [
          {
            block,
            children: [{ text: '' }],
            id: `embed${index}`,
            type: block.type,
          },
        ],
      })),
    {
      kind: 'mindmap',
      name: 'mindmap',
      value: [
        {
          children: [
            { children: [{ text: 'cap' }], id: 'c1', type: 'mermaid_caption' },
          ],
          id: 'm1',
          source: 'mindmap\n  root',
          type: 'mindmap',
        },
      ],
    },
    {
      kind: 'note',
      name: 'html-embeds',
      value: Array.from({ length: 10 }, (_, i) => ({
        caption: 'Tangent',
        children: [{ text: '' }],
        html: 'é'.repeat(32_768),
        id: `e${i}`,
        type: 'html_embed',
      })),
    },
    // The caption (main 55881d39, was title): a string, and nothing else.
    ...[
      ['caption', { caption: 'Tangent' }],
      ['caption number', { caption: 7 }],
      ['legacy title', { title: 'Tangent' }],
    ].map(([name, field]) => ({
      kind: 'note',
      name: `html-embed ${name}`,
      value: [
        {
          children: [{ text: '' }],
          html: '<p>x</p>',
          id: 'h1',
          type: 'html_embed',
          ...(field as Record<string, unknown>),
        },
      ],
    })),
  ];
  const cases: unknown[] = [];
  const record = (
    name: string,
    kind: string,
    value: unknown[],
    host: string | null = null
  ) =>
    cases.push({
      host,
      kind,
      name,
      outcome: withEnv(host, () =>
        outcome(() => assertCanonicalMaterialValue(value, kind))
      ),
      value,
    });
  for (const base of bases) {
    const small = JSON.stringify(base.value).length < 64_000;
    const kinds = ['note', 'quiz', 'flashcards', 'diagram', 'x'];
    for (const kind of small ? [base.kind, ...kinds] : [base.kind])
      record(base.name, kind, base.value);
    for (let index = 0; small && index < 40; index += 1)
      record(
        `${base.name} mutation ${index}`,
        base.kind,
        mutate(base.value, random)
      );
  }
  for (const url of [
    'https://bank.example/assets/f.png',
    'https://bank.example.evil/assets/f.png',
    'https://bank.example/assets/../private/f.png',
    'https://bank.example/assetsx/f.png',
    'https://bank.example/assets/f.png?x=1',
    'https://bank.example/assets/f.png#x',
    'https://user@bank.example/assets/f.png',
    'http://bank.example/assets/f.png',
    '  https://bank.example/assets/f.png  ',
  ]) {
    const question = structuredClone(biologyQuizQuestions[0]) as {
      stem: unknown[];
    };
    question.stem = [
      {
        description: 'A figure',
        height: 300,
        image: { url },
        type: 'image',
        width: 400,
      },
    ];
    for (const host of [null, '', BANK_HOST, `${BANK_HOST}/`])
      record(`figure ${url}`, 'quiz', quizOf(question), host);
  }
  write('validation', { cases, questions: questionCases }, true);
}

/* ------------------------------------------------------------------ edits */

const EDIT_CLIENT = 4000;

/** One call of a document function on a copy of `state`, by a fixed client:
 * its result or EditError, the update it made, and the value after. */
function editCall(
  state: Uint8Array,
  clientID: number,
  run: (document: Y.Doc) => unknown
): Record<string, unknown> {
  const document = docFromState(state, clientID);
  const before = Y.encodeStateVector(document);
  try {
    const result = run(document);
    const update = Y.encodeStateAsUpdate(document, before);
    return {
      ok: result ?? null,
      update: b64(update),
      value: plate(document),
    };
  } catch (error) {
    return error instanceof EditError
      ? {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        }
      : { thrown: (error as Error).message };
  }
}

function textOf(document: Y.Doc) {
  return document.getText('source').toString();
}

/** A scripted sequence on one document: each step runs on the state the
 * previous steps left (a failed step leaves it unchanged, as the caller
 * discards the copy). */
type Step = (
  document: Y.Doc,
  outcomes: Record<string, unknown>[],
  action: Record<string, unknown>
) => unknown;

function script(name: string, initial: Uint8Array, steps: Step[]) {
  let state = initial;
  let client = EDIT_CLIENT;
  const records: Record<string, unknown>[] = [];
  for (const step of steps) {
    client += 1;
    const action: Record<string, unknown> = {};
    const record = editCall(state, client, (document) =>
      step(document, records, action)
    );
    const before = state;
    if ('update' in record) {
      const next = docFromState(state, 1);
      Y.applyUpdate(next, b64decode(record.update as string));
      state = Y.encodeStateAsUpdate(next);
    }
    records.push({ ...record, action, client, state: b64(before) });
  }
  return { name, steps: records };
}

const b64decode = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

/** The scenarios of editCommands.test.ts, as data. */
function editScenarios() {
  const paragraphOf = (id: string, text: string) => ({
    children: [{ text }],
    id,
    type: 'p',
  });
  const material = (value: unknown[]) =>
    Y.encodeStateAsUpdate(docWithValue(value, 1));
  const apply =
    (commands: DocumentCommand[]): Step =>
    (document, _records, action) => {
      Object.assign(action, { commands, kind: 'apply' });
      return applyMaterialCommands(document, commands);
    };
  const outcomeOf = (records: Record<string, unknown>[], index: number) =>
    records[index].ok as { guards: GuardTarget[]; inverse: DocumentCommand[] };
  const verify =
    (index: number): Step =>
    (document, records, action) => {
      Object.assign(action, { kind: 'verify', of: index });
      return verifyMaterialGuards(document, outcomeOf(records, index).guards);
    };
  const undo =
    (index: number): Step =>
    (document, records, action) => {
      Object.assign(action, { kind: 'undo', of: index });
      return applyMaterialCommands(document, outcomeOf(records, index).inverse);
    };
  const inspect = (): Step => (document, _records, action) => {
    action.kind = 'inspect';
    return inspectMaterial(document);
  };
  const question = {
    id: 'q1',
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: { correct: true, type: 'boolean' },
        blocks: [{ text: 'True?', type: 'text' }],
        id: 'p1',
        marks: 1,
        solution: [],
      },
    ],
    stem: [{ text: 'Shared context', type: 'text' }],
  };
  const quizQuestion = (q: Record<string, unknown>) => ({
    children: [{ text: '' }],
    id: 'q1',
    question: q,
    type: 'quiz_question',
  });
  const card = (id: string, front: string) => ({
    children: [
      { children: [{ text: front }], type: 'flashcard_front' },
      { children: [{ text: `${front} back` }], type: 'flashcard_back' },
    ],
    id,
    type: 'flashcard',
  });
  const rich = (id: string, where: string, grows: string) => ({
    children: [
      { text: 'See ' },
      { children: [{ text: 'the source' }], type: 'a', url: 'https://x.org' },
      { text: where },
      {
        children: [{ text: '' }],
        texExpression: 'x^2',
        type: 'inline_equation',
      },
      { text: grows },
    ],
    id,
    type: 'p',
  });
  const mathLine = {
    children: [
      { text: 'The slope ' },
      { children: [{ text: '' }], texExpression: 'm', type: 'inline_equation' },
      { text: ' is steep.' },
    ],
    id: 'b1',
    type: 'p',
  };
  const formula = {
    children: [{ text: '' }],
    id: 'f1',
    texExpression: 'P(X=k)',
    type: 'equation',
  };
  const four = [
    paragraphOf('b1', 'alpha'),
    paragraphOf('b2', 'beta'),
    paragraphOf('b3', 'gamma'),
    paragraphOf('b4', 'delta'),
  ];
  return [
    script(
      'void question',
      material([
        { children: [quizQuestion(question)], id: 'quiz1', type: 'quiz' },
      ]),
      [
        inspect(),
        apply([
          {
            node: quizQuestion({
              ...question,
              stem: [{ text: 'Changed context', type: 'text' }],
            }),
            nodeId: 'q1',
            parentType: 'quiz',
            type: 'replace_child',
          },
        ]),
        verify(1),
        undo(1),
        inspect(),
      ]
    ),
    script(
      'replace text and undo',
      material([paragraphOf('b1', 'alpha beta'), paragraphOf('b2', 'gamma')]),
      [
        apply([
          {
            blockId: 'b1',
            expectedText: 'beta',
            text: 'delta',
            type: 'replace_text',
          },
        ]),
        inspect(),
        verify(0),
        undo(0),
        inspect(),
      ]
    ),
    script(
      'material reference',
      material([
        paragraphOf('b1', 'intro'),
        {
          children: [{ text: '' }],
          id: 'r1',
          materialId: 'mat_q',
          refKind: 'quiz',
          type: 'material_ref',
        },
      ]),
      [inspect()]
    ),
    script('removal undo and a written gap', material(four.slice(0, 3)), [
      apply([{ blockId: 'b2', expectedText: 'beta', type: 'remove_block' }]),
      verify(0),
      undo(0),
      apply([
        {
          afterBlockId: 'b1',
          blocks: [paragraphOf('bx', 'x')],
          type: 'insert_block',
        },
      ]),
      apply([{ blockId: 'bx', expectedText: 'x', type: 'remove_block' }]),
      verify(0),
    ]),
    script(
      'neighbours keep an undo valid',
      material([
        paragraphOf('b1', 'alpha'),
        paragraphOf('b2', 'beta'),
        {
          children: [card('c1', 'one'), card('c2', 'two')],
          id: 'deck',
          type: 'flashcards',
        },
      ]),
      [
        apply([
          {
            blockId: 'b2',
            expectedText: 'beta',
            text: 'BETA',
            type: 'replace_text',
          },
          {
            node: card('c1', 'uno'),
            nodeId: 'c1',
            parentType: 'flashcards',
            type: 'replace_child',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            expectedText: 'alpha',
            text: 'ALPHA',
            type: 'replace_text',
          },
          {
            node: card('c2', 'dos'),
            nodeId: 'c2',
            parentType: 'flashcards',
            type: 'replace_child',
          },
        ]),
        verify(0),
        apply([
          {
            node: card('c1', 'ein'),
            nodeId: 'c1',
            parentType: 'flashcards',
            type: 'replace_child',
          },
        ]),
        verify(0),
        apply([
          {
            afterNodeId: 'c1',
            node: card('c3', 'three'),
            parentType: 'flashcards',
            type: 'insert_child',
          },
        ]),
        apply([
          { nodeId: 'c2', parentType: 'flashcards', type: 'remove_child' },
        ]),
        undo(6),
        apply([
          { nodeId: 'c9', parentType: 'flashcards', type: 'remove_child' },
        ]),
        apply([
          {
            afterNodeId: 'c9',
            node: card('c4', 'x'),
            parentType: 'flashcards',
            type: 'insert_child',
          },
        ]),
      ]
    ),
    script('adjacent removals', material(four), [
      apply([
        { blockId: 'b3', expectedText: 'gamma', type: 'remove_block' },
        { blockId: 'b2', expectedText: 'beta', type: 'remove_block' },
      ]),
      verify(0),
      undo(0),
    ]),
    script('insert then remove in one call', material(four.slice(0, 2)), [
      apply([
        {
          afterBlockId: 'b1',
          blocks: [paragraphOf('b9', 'nine')],
          type: 'insert_block',
        },
        { blockId: 'b9', expectedText: 'nine', type: 'remove_block' },
      ]),
      verify(0),
    ]),
    script('gap two away', material(four), [
      apply([{ blockId: 'b2', expectedText: 'beta', type: 'remove_block' }]),
      apply([{ blockId: 'b4', expectedText: 'delta', type: 'remove_block' }]),
      verify(0),
    ]),
    script('gap beside an edit', material(four.slice(0, 2)), [
      apply([{ blockId: 'b2', expectedText: 'beta', type: 'remove_block' }]),
      apply([
        {
          blockId: 'b1',
          expectedText: 'alpha',
          text: 'alpha!',
          type: 'replace_text',
        },
      ]),
      verify(0),
    ]),
    // Main's 69f02a63: links and inline equations survive an edit, and a span
    // that only touches an inline element leaves it out.
    script(
      'inline elements beside a replaced span',
      material([
        rich('b1', ' where ', ' grows fast.'),
        rich('b2', ' where ', ' grows fast.'),
      ]),
      [
        apply([
          {
            blockId: 'b1',
            expectedText: ' where ',
            text: ' when ',
            type: 'replace_text',
          },
          {
            blockId: 'b1',
            expectedText: ' grows fast.',
            text: ' grows quickly.',
            type: 'replace_text',
          },
        ]),
        inspect(),
        verify(0),
        undo(0),
        inspect(),
        apply([
          {
            blockId: 'b2',
            expectedText: 'See the source',
            text: 'Read',
            type: 'replace_text',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            expectedText: 'the source where',
            text: 'it when',
            type: 'replace_text',
          },
        ]),
      ]
    ),
    // Main's f11f830f: a stale expectation carries the block as it reads, a
    // gone id the material's blocks.
    script(
      'missed targets as they read now',
      material([paragraphOf('b1', 'alpha beta'), paragraphOf('b2', 'gamma')]),
      [
        apply([
          {
            blockId: 'b1',
            expectedText: 'delta',
            text: 'x',
            type: 'replace_text',
          },
        ]),
        apply([{ blockId: 'b2', expectedText: 'gam', type: 'remove_block' }]),
        apply([
          {
            blockId: 'gone',
            expectedText: 'x',
            text: 'y',
            type: 'replace_text',
          },
        ]),
        apply([{ blockId: 'gone', expectedText: 'x', type: 'remove_block' }]),
        apply([
          {
            blockId: 'b1',
            expectedText: 'beta',
            text: 'BETA',
            type: 'replace_text',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            expectedText: 'BETA',
            text: 'Beta',
            type: 'replace_text',
          },
        ]),
        undo(4),
        apply([
          { blockId: 'b1', expectedText: 'a', text: 'A', type: 'replace_text' },
        ]),
      ]
    ),
    script(
      'a gone id lists sixty blocks',
      material([
        paragraphOf('p0', `\u{1F600}${'long text '.repeat(12)}`),
        {
          children: [
            { text: 'Area ' },
            {
              children: [{ text: '' }],
              texExpression: '\\pi r^2',
              type: 'inline_equation',
            },
            { text: ' of a circle' },
          ],
          id: 'p1',
          type: 'p',
        },
        ...Array.from({ length: 63 }, (_, i) =>
          paragraphOf(`p${i + 2}`, `${i + 2} ${'é word '.repeat(i % 15)}`)
        ),
      ]),
      [apply([{ blockId: 'gone', expectedText: 'x', type: 'remove_block' }])]
    ),
    // Main's a6a54603: an insert whose anchor is gone lands, and says where.
    script('insert after a gone anchor', material(four.slice(0, 3)), [
      apply([
        {
          afterBlockId: 'deleted',
          blocks: [paragraphOf('n1', 'one')],
          type: 'insert_block',
        },
      ]),
      verify(0),
      undo(0),
      apply([
        { blockId: 'b2', expectedText: 'beta', type: 'remove_block' },
        {
          afterBlockId: 'b2',
          blocks: [paragraphOf('n2', 'two')],
          type: 'insert_block',
        },
      ]),
      verify(3),
      undo(3),
      apply([
        { blockId: 'b1', expectedText: 'alpha', type: 'remove_block' },
        { blockId: 'b2', expectedText: 'beta', type: 'remove_block' },
        {
          afterBlockId: 'b2',
          blocks: [paragraphOf('n3', 'three')],
          type: 'insert_block',
        },
      ]),
      verify(6),
      undo(6),
      apply([
        {
          blockId: 'b2',
          blocks: [paragraphOf('r1', 'r one'), paragraphOf('r2', 'r two')],
          expectedText: 'beta',
          type: 'replace_block',
        },
        {
          afterBlockId: 'b2',
          blocks: [paragraphOf('n4', 'four')],
          type: 'insert_block',
        },
      ]),
      verify(9),
      undo(9),
      inspect(),
    ]),
    // Main's 82c9fd29: math reads as $tex$ / $$tex$$, replace_text keeps to
    // the plain text around it, replace_block rewrites a block in place.
    script(
      'math and replace_block',
      material([mathLine, formula, paragraphOf('b3', 'end')]),
      [
        inspect(),
        apply([
          {
            blockId: 'b1',
            expectedText: 'slope $m$',
            text: 'gradient',
            type: 'replace_text',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            expectedText: ' is steep.',
            text: ' is gentle.',
            type: 'replace_text',
          },
        ]),
        inspect(),
        undo(2),
        inspect(),
        apply([
          {
            blockId: 'f1',
            blocks: [
              { children: [{ text: 'Binomial' }], id: 'n1', type: 'h2' },
              paragraphOf('n2', 'The chance of k successes.'),
            ],
            expectedText: '$$P(X=k)$$',
            type: 'replace_block',
          },
        ]),
        verify(6),
        undo(6),
        inspect(),
        apply([
          {
            blockId: 'f1',
            blocks: [paragraphOf('n3', 'x')],
            expectedText: '$$P(X=1)$$',
            type: 'replace_block',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            expectedText: 'The slope ',
            text: 'A slope ',
            type: 'replace_text',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            expectedText: '$ is',
            text: 'x',
            type: 'replace_text',
          },
        ]),
        apply([
          {
            blockId: 'f1',
            expectedText: 'X=k',
            text: 'X=j',
            type: 'replace_text',
          },
        ]),
        undo(11),
        apply([
          {
            blockId: 'b1',
            expectedText: '',
            offset: 11,
            text: 'Q',
            type: 'replace_text',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            expectedText: '',
            offset: 13,
            text: 'Q',
            type: 'replace_text',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            blocks: [],
            expectedText: 'The slope $m$Q is steep.',
            type: 'replace_block',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            blocks: [paragraphOf('b3', 'dup')],
            expectedText: 'The slope $m$Q is steep.',
            type: 'replace_block',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            blocks: [paragraphOf('b1', 'same id')],
            expectedText: 'The slope $m$Q is steep.',
            type: 'replace_block',
          },
        ]),
        apply([
          {
            blockId: 'gone',
            blocks: [paragraphOf('n5', 'x')],
            expectedText: 'x',
            type: 'replace_block',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            blocks: [{ id: 'n6', type: 'p' }],
            expectedText: 'The slope $m$Q is steep.',
            type: 'replace_block',
          },
        ]),
      ]
    ),
    script('stale expectation', material(four.slice(0, 1)), [
      apply([
        {
          blockId: 'b1',
          expectedText: 'nope',
          text: 'x',
          type: 'replace_text',
        },
        {
          afterBlockId: 'b1',
          blocks: [paragraphOf('b9', 'new')],
          type: 'insert_block',
        },
      ]),
    ]),
    script('changed after the edit', material(four.slice(0, 2)), [
      apply([
        {
          afterBlockId: 'b1',
          blocks: [paragraphOf('b3', 'inserted')],
          type: 'insert_block',
        },
      ]),
      verify(0),
      apply([
        {
          blockId: 'b3',
          expectedText: 'inserted',
          text: 'changed',
          type: 'replace_text',
        },
      ]),
      verify(0),
      apply([{ blockId: 'b3', expectedText: 'changed', type: 'remove_block' }]),
      verify(0),
    ]),
    script(
      'refusals',
      material([
        paragraphOf('b1', 'aa aa'),
        { assetId: 'a1', children: [{ text: '' }], id: 'm1', type: 'img' },
      ]),
      [
        apply([]),
        apply([{ expectedText: 'aa', text: 'b', type: 'replace_text' }]),
        apply([
          {
            blockId: 'b1',
            expectedText: 'aa',
            text: 'b',
            type: 'replace_text',
          },
        ]),
        apply([
          { blockId: 'b1', expectedText: '', text: 'b', type: 'replace_text' },
        ]),
        apply([
          {
            blockId: 'zz',
            expectedText: 'aa',
            text: 'b',
            type: 'replace_text',
          },
        ]),
        apply([
          { blockId: 'm1', expectedText: 'x', text: 'b', type: 'replace_text' },
        ]),
        apply([{ blockId: 'm1', expectedText: '', type: 'remove_block' }]),
        apply([{ afterBlockId: null, blocks: [], type: 'insert_block' }]),
        apply([
          {
            afterBlockId: null,
            blocks: [{ children: [], type: 'p' }],
            type: 'insert_block',
          },
        ]),
        apply([
          {
            afterBlockId: null,
            blocks: [{ id: 'x', type: 'p' }],
            type: 'insert_block',
          },
        ]),
        apply([
          {
            afterBlockId: null,
            blocks: [{ children: [{ text: '' }], id: 'x', type: 'video' }],
            type: 'insert_block',
          },
        ]),
        apply([
          {
            afterBlockId: null,
            blocks: [paragraphOf('b1', 'dup')],
            type: 'insert_block',
          },
        ]),
        apply([{ blockId: 'b1', expectedText: 'aa aa', type: 'remove_block' }]),
        apply([
          {
            expectedValue: '',
            nodeType: 'p',
            property: 'align',
            type: 'set_property',
            value: 'center',
          },
        ]),
        apply([
          {
            expectedValue: 'x',
            nodeType: 'p',
            property: 'align',
            type: 'set_property',
            value: 'left',
          },
        ]),
        apply([
          {
            expectedValue: '',
            nodeType: 'quiz',
            property: 'title',
            type: 'set_property',
            value: 'x',
          },
        ]),
        apply([
          {
            node: paragraphOf('b1', 'x'),
            nodeId: 'b1',
            parentType: 'quiz',
            type: 'replace_child',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            expectedText: 'a'.repeat(200_001),
            text: 'x',
            type: 'replace_text',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            expectedText: 'aa',
            offset: 3,
            text: 'XY',
            type: 'replace_text',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            expectedText: 'aa',
            offset: 1,
            text: 'XY',
            type: 'replace_text',
          },
        ]),
        apply([
          {
            blockId: 'm1',
            blocks: [paragraphOf('m2', 'x')],
            expectedText: '',
            type: 'replace_block',
          },
        ]),
        apply([
          {
            blockId: 'b1',
            blocks: [{ children: [{ text: '' }], id: 'v1', type: 'video' }],
            expectedText: 'aa aa',
            type: 'replace_block',
          },
        ]),
      ]
    ),
  ];
}

/** Text source scenarios from editCommands.test.ts. */
function textScenarios() {
  const source = (text: string) => {
    const document = newDoc(1);
    document.getText('source').insert(0, text);
    return Y.encodeStateAsUpdate(document);
  };
  const apply =
    (commands: DocumentCommand[]): Step =>
    (document, _records, action) => {
      Object.assign(action, { commands, kind: 'apply' });
      const outcome = applyTextCommands(document, commands);
      return { ...outcome, text: textOf(document) };
    };
  const verify =
    (index: number): Step =>
    (document, records, action) => {
      Object.assign(action, { kind: 'verify', of: index });
      return verifyTextGuards(
        document,
        (records[index].ok as { guards: GuardTarget[] }).guards
      );
    };
  const edit =
    (change: (text: Y.Text) => void): Step =>
    (document, _records, action) => {
      action.kind = 'edit';
      change(document.getText('source'));
      return textOf(document);
    };
  return [
    script('text replace and guards', source('one two three'), [
      apply([{ expectedText: 'two', text: '2', type: 'replace_text' }]),
      verify(0),
      edit((text) => text.insert(5, '!')),
      verify(0),
      edit((text) => text.delete(4, 1)),
      verify(0),
    ]),
    script('text batch', source('AAA BBB'), [
      apply([
        { expectedText: 'BBB', text: 'CCCCCC', type: 'replace_text' },
        { expectedText: 'AAA', text: '', type: 'replace_text' },
      ]),
      verify(0),
    ]),
    script('text moved span', source('one two three'), [
      apply([{ expectedText: 'two', text: '2', type: 'replace_text' }]),
      edit((text) => text.insert(0, 'prefix ')),
      verify(0),
      edit((text) => text.insert(11, '!')),
      verify(0),
      edit((text) => text.delete(text.toString().indexOf('2'), 1)),
      verify(0),
    ]),
    script('text refusals', source('abcdef aa aa'), [
      apply([
        { expectedText: 'bcd', text: 'X', type: 'replace_text' },
        { expectedText: 'aX', text: 'y', type: 'replace_text' },
      ]),
      apply([{ expectedText: 'aa', text: 'b', type: 'replace_text' }]),
      apply([
        {
          blockId: 'x',
          expectedText: 'cde',
          text: 'é😀',
          type: 'replace_text',
        },
      ]),
      apply([{ afterBlockId: null, blocks: [], type: 'insert_block' }]),
      apply([
        { expectedText: 'f', text: 'x'.repeat(200_001), type: 'replace_text' },
      ]),
    ]),
  ];
}

/** Random agent edits on the fixture notes, each followed by its guard check
 * and its Undo. */
function randomEditScripts(seed: number) {
  const random = seeded(seed);
  const pick = <T>(list: readonly T[]) =>
    list[Math.floor(random() * list.length)];
  const words = ['alpha', 'β', 'é', '😀', ' ', 'x', '"q"', '\\', '\n', 'cell'];
  const word = () =>
    Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
      pick(words)
    ).join('');
  const bases: { name: string; value: unknown[] }[] = [
    ...seedNotes
      .slice(0, 4)
      .map((note) => ({ name: note.id, value: withIds(note.value) })),
    ...Object.entries(smallNotes).map(([name, value]) => ({
      name,
      value: withIds(value),
    })),
    ...embeddedSeeds
      .slice(0, 3)
      .map((seed) => ({ name: seed.id, value: withIds([seed.block]) })),
  ];
  const scripts: ReturnType<typeof script>[] = [];
  for (const base of bases) {
    const steps: Step[] = [];
    for (let round = 0; round < 12; round += 1) {
      steps.push((document, _records, action) => {
        const value = (
          yTextToSlateElement(document.get('content', Y.XmlText)) as {
            children: Record<string, unknown>[];
          }
        ).children;
        const block = pick(value);
        const id = typeof block.id === 'string' ? block.id : '';
        const text = blockText(block as never);
        const roll = random();
        let commands: DocumentCommand[];
        if (roll < 0.5 && text.length > 0) {
          // A unique span: grow from a random point until it occurs once.
          let from = Math.floor(random() * text.length);
          if (LOW_SURROGATE.test(text[from] ?? '')) from -= 1;
          let to = from + 1;
          while (
            to < text.length &&
            text.split(text.slice(from, to)).length > 2
          )
            to += 1;
          if (HIGH_SURROGATE.test(text[to - 1] ?? '')) to += 1;
          commands = [
            {
              blockId: id,
              expectedText: text.slice(from, to),
              text: random() < 0.2 ? '' : word(),
              type: 'replace_text',
            },
          ];
        } else if (roll < 0.65) {
          commands = [
            {
              afterBlockId: random() < 0.2 ? null : id,
              blocks: [
                {
                  children: [{ text: word() }, { bold: true, text: word() }],
                  id: `n${round}${Math.floor(random() * 1e6)}`,
                  type: 'p',
                },
              ],
              type: 'insert_block',
            },
          ];
        } else if (roll < 0.78) {
          commands = [
            { blockId: id, expectedText: text, type: 'remove_block' },
          ];
        } else if (roll < 0.88) {
          const replacement = () => ({
            children: [{ text: word() }],
            id: `r${round}${Math.floor(random() * 1e6)}`,
            type: 'p',
          });
          commands = [
            {
              blockId: id,
              blocks:
                random() < 0.3
                  ? [replacement(), replacement()]
                  : [replacement()],
              expectedText: text,
              type: 'replace_block',
            },
          ];
        } else if (roll < 0.96) {
          commands = [
            {
              expectedValue: typeof block.align === 'string' ? block.align : '',
              nodeType: String(block.type),
              property: 'align',
              type: 'set_property',
              value: pick(['center', 'right', '']),
            },
          ];
        } else {
          commands = [
            {
              blockId: id,
              expectedText: 'not there',
              text: 'x',
              type: 'replace_text',
            },
          ];
        }
        Object.assign(action, { commands, kind: 'apply' });
        return applyMaterialCommands(document, commands);
      });
      const index = steps.length - 1;
      steps.push((document, records, action) => {
        const done = records[index]?.ok as
          | { guards: GuardTarget[] }
          | undefined;
        if (!done) return 'skipped';
        Object.assign(action, { kind: 'verify', of: index });
        return verifyMaterialGuards(document, done.guards);
      });
      steps.push((document, records, action) => {
        const done = records[index]?.ok as
          | { inverse: DocumentCommand[] }
          | undefined;
        if (!done || random() < 0.5) return 'kept';
        Object.assign(action, { kind: 'undo', of: index });
        return applyMaterialCommands(document, done.inverse);
      });
    }
    scripts.push(
      script(
        `random ${base.name}`,
        Y.encodeStateAsUpdate(docWithValue(base.value, 1)),
        steps
      )
    );
  }
  return scripts;
}

function editsFamily() {
  write(
    'edits',
    {
      material: [...editScenarios(), ...randomEditScripts(21)],
      text: textScenarios(),
    },
    true
  );
}

/* --------------------------------------------- children, replace-block, inspect */

function childrenFamily() {
  const random = seeded(31);
  const pick = <T>(list: readonly T[]) =>
    list[Math.floor(random() * list.length)];
  const quizBlock = (id: string, materialId: string) => ({
    children: [{ text: '' }],
    id,
    materialId,
    refKind: 'quiz',
    type: 'material_ref',
  });
  const image = (id: string, assetId: string) => ({
    assetId,
    children: [{ text: '' }],
    id,
    type: 'img',
  });
  const para = (text: string) => ({
    children: [{ text }],
    id: `p-${text}`,
    type: 'p',
  });
  const cases: unknown[] = [];
  const record = (
    name: string,
    before: unknown[],
    edit: (root: Y.XmlText, document: Y.Doc) => void,
    answer: (plan: { assetIds: string[]; blocks: { blockId: string }[] }) => {
      assets: [string, string][];
      blocks: [string, string][];
    }
  ) => {
    const document = docWithValue(before, 1);
    const state = Y.encodeStateAsUpdate(document);
    const writer = docFromState(state, 2);
    edit(writer.get('content', Y.XmlText), writer);
    const update = Y.encodeStateAsUpdate(writer, Y.encodeStateVector(document));
    Y.applyUpdate(document, update);
    const writes = childWrites(document, update);
    const plan = writes ? planChildren(document, writes) : null;
    const chosen = plan ? answer(plan) : { assets: [], blocks: [] };
    const map = {
      assets: new Map(chosen.assets),
      blocks: new Map(chosen.blocks),
    };
    const after = Y.encodeStateAsUpdate(document);
    cases.push({
      answer: chosen,
      applied: editCall(after, 7, (copy) => applyChildren(copy, map)),
      kept: plan ? keptIds(plan, map) : null,
      name,
      plan,
      state: b64(after),
      update: b64(update),
      writes: writes && {
        assetIds: writes.assetIds,
        blocks: [...writes.blocks].map((block) => block.getAttribute('id')),
      },
    });
  };
  const append = (inserted: unknown[]) => (root: Y.XmlText) =>
    root.applyDelta([
      { retain: root.length },
      ...slateNodesToInsertDelta(inserted as never),
    ]);
  const none = () => ({ assets: [], blocks: [] });
  record(
    'writes, not typing',
    [para('intro'), quizBlock('b1', 'mat_own')],
    append([quizBlock('b2', 'mat_other'), image('i1', 'asset_other')]),
    none
  );
  record('typing', [para('intro')], append([para('more')]), none);
  record(
    'overwrite',
    [para('intro'), quizBlock('b1', 'mat_own')],
    (root) => {
      (root.toDelta()[1].insert as Y.XmlText).setAttribute(
        'materialId',
        'mat_next'
      );
    },
    (plan) => ({
      assets: [],
      blocks: plan.blocks.map((b) => [b.blockId, 'mat_copy']),
    })
  );
  record(
    'copies',
    [quizBlock('b1', 'mat_own')],
    append([
      quizBlock('b2', 'mat_own'),
      quizBlock('b3', 'mat_other'),
      quizBlock('b4', 'mat_other'),
    ]),
    (plan) => ({
      assets: [],
      blocks: plan.blocks.map((b, i) => [
        b.blockId,
        i === 0 ? '' : `mat_c${i}`,
      ]),
    })
  );
  record(
    'repoint and drop',
    [para('intro')],
    append([
      quizBlock('b1', 'mat_other'),
      quizBlock('b2', 'mat_purged'),
      image('i1', 'asset_other'),
      image('i2', 'asset_own'),
      image('i3', 'asset_gone'),
    ]),
    () => ({
      assets: [
        ['asset_other', 'asset_copy'],
        ['asset_own', 'asset_own'],
        ['asset_gone', ''],
      ],
      blocks: [
        ['b1', 'mat_copy'],
        ['b2', ''],
      ],
    })
  );
  record(
    'inline link elsewhere',
    [
      {
        children: [
          { text: 'see ' },
          { children: [{ text: 'link' }], type: 'a', url: 'https://x.test' },
          { text: ' end' },
        ],
        id: 'l1',
        type: 'p',
      },
    ],
    append([image('i1', 'asset_other')]),
    () => ({ assets: [['asset_other', 'asset_other']], blocks: [] })
  );
  for (let round = 0; round < 30; round += 1) {
    const base = withIds(pick(seedNotes).value);
    const extra = Array.from(
      { length: 1 + Math.floor(random() * 4) },
      (_, i) =>
        random() < 0.5
          ? quizBlock(`r${round}-${i}`, pick(['mat_a', 'mat_b', 'mat_c']))
          : image(`i${round}-${i}`, pick(['asset_a', 'asset_b']))
    );
    record(`random ${round}`, base, append(extra), (plan) => ({
      assets: plan.assetIds.map((id) => [id, pick(['', id, `${id}_copy`])]),
      blocks: plan.blocks.map((b) => [b.blockId, pick(['', 'mat_a', 'mat_x'])]),
    }));
  }
  write('children', cases, true);
}

function commandsFamily() {
  const random = seeded(41);
  const cases: unknown[] = [];
  const record = (
    name: string,
    value: unknown[],
    command: Record<string, unknown>
  ) => {
    const state = Y.encodeStateAsUpdate(docWithValue(value, 1));
    cases.push({
      command,
      name,
      result: editCall(state, 8, (document) =>
        applyCollaborationCommand(document, command as never)
      ),
      state: b64(state),
    });
  };
  const base = {
    actorUserId: 'u_editor',
    materialId: 'material-1',
    room: 'material:material-1:schema:1',
    type: 'replace-block',
  };
  const first = { children: [{ text: 'Keep me' }], id: 'first', type: 'p' };
  const quiz = {
    children: [{ children: [{ text: 'Old' }], id: 'q1', type: 'p' }],
    id: 'quiz',
    type: 'quiz',
  };
  const replacement = {
    ...quiz,
    children: [{ children: [{ text: 'New' }], id: 'q1', type: 'p' }],
  };
  record('replace', [first, quiz], {
    ...base,
    expectedBlock: quiz,
    replacementBlock: replacement,
  });
  record('stale', [first], {
    ...base,
    expectedBlock: { ...first, children: [{ text: 'Old' }] },
    replacementBlock: first,
  });
  record('same', [first], {
    ...base,
    expectedBlock: first,
    replacementBlock: first,
  });
  record('revision stale', [first], {
    ...base,
    expectedBlock: { ...first, id: ' first ' },
    expectedRevision: 3,
    replacementBlock: first,
  });
  record('id changed', [first], {
    ...base,
    expectedBlock: first,
    replacementBlock: { ...first, id: 'other' },
  });
  record('type changed', [first], {
    ...base,
    expectedBlock: first,
    replacementBlock: { ...first, type: 'h1' },
  });
  record('no children', [first], {
    ...base,
    expectedBlock: first,
    replacementBlock: { id: 'first', type: 'p' },
  });
  record('missing', [first], {
    ...base,
    expectedBlock: { ...first, id: 'gone' },
    replacementBlock: { ...first, id: 'gone' },
  });
  record(
    'nested target',
    [
      {
        children: [{ children: [{ text: 'cell' }], id: 'inner', type: 'p' }],
        id: 'outer',
        type: 'blockquote',
      },
    ],
    {
      ...base,
      expectedBlock: { children: [{ text: 'cell' }], id: 'inner', type: 'p' },
      replacementBlock: {
        children: [{ text: 'cell!' }, { bold: true, text: 'b' }],
        id: 'inner',
        type: 'p',
      },
    }
  );
  for (const note of seedNotes.slice(0, 5)) {
    const value = withIds(note.value) as Record<string, unknown>[];
    for (let round = 0; round < 4; round += 1) {
      const target = value[Math.floor(random() * value.length)];
      record(`${note.id} ${round}`, value, {
        ...base,
        expectedBlock: target,
        replacementBlock: {
          ...target,
          children: [
            { text: `replaced ${round}` },
            { italic: true, text: 'é😀' },
          ],
        },
      });
    }
  }
  write('commands', cases, true);
}

function inspectFamily() {
  const values: [string, unknown[]][] = [
    ...seedNotes.map((note): [string, unknown[]] => [
      note.id,
      withIds(note.value),
    ]),
    ...Object.entries(smallNotes),
    ...embeddedSeeds.map((seed): [string, unknown[]] => [
      seed.id,
      withIds([seed.block]),
    ]),
  ];
  write(
    'inspect',
    values.map(([name, value]) => {
      const document = docWithValue(value, 1);
      return {
        blocks: inspectMaterial(document),
        name,
        state: b64(Y.encodeStateAsUpdate(document)),
      };
    }),
    true
  );
}

/* --------------------------------------------------------------- markdown */

/** Agent markdown through the Node server's converter (the editor's import,
 * bundled): synthetic samples of each construct, then the repository's own
 * markdown pages as long real-world input. */
async function markdownFamily() {
  const samples: [string, string][] = [
    [
      'quiz and mermaid',
      '## Mini check\n\n```quiz\nquestions:\n  - {id: q1}\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```',
    ],
    [
      'headings and marks',
      '# H1\n\n## H2 *em* **strong** ~~del~~ `code`\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n\nPlain with **bold _nested italic_** and ***both***.',
    ],
    [
      'lists',
      '- one\n- two\n  - nested\n    - deeper\n- three\n\n1. first\n2. second\n   1. inner\n\n- [ ] todo\n- [x] done',
    ],
    [
      'code fences',
      '```ts\nconst x: number = 1;\n```\n\n```\nplain\n```\n\n    indented code\n\n```python\ndef f():\n    return 1\n```',
    ],
    [
      'table',
      '| a | b |\n|---|:-:|\n| 1 | **2** |\n| `x` | [l](https://x.test) |',
    ],
    ['quote and rule', '> quoted\n> **line**\n\n---\n\n> nested\n>> deeper'],
    [
      'links and images',
      '[text](https://example.com "title") and <https://auto.link> and ![alt](https://example.com/a.png)',
    ],
    ['math', 'Inline $x^2 + y_1$ and display:\n\n$$\n\\int_0^1 x\\,dx\n$$\n'],
    [
      'html',
      '<div>raw <b>html</b></div>\n\ntext <sub>sub</sub> <sup>sup</sup> <kbd>k</kbd>',
    ],
    [
      'emoji and escapes',
      'Smile :smile: and \\*not em\\* and &amp; &copy; &#169;',
    ],
    [
      'flashcards',
      '```flashcards\ncards:\n  - front: Q1\n    back: A1\n  - front: Q2\n    back: A2\n```',
    ],
    ['bad quiz yaml', '```quiz\nquestions: [unclosed\n```'],
    ['empty quiz', '```quiz\nquestions: []\n```'],
    ['bad cards', '```flashcards\ncards:\n  - front: only\n```'],
    ['html embed', '```html-embed\n<p>Hello</p>\n```'],
    [
      'html embed caption',
      '```html-embed\ncaption: Tangent\nhtml: |\n  <svg id="fig"></svg>\n  <script>draw(40)</script>\n```',
    ],
    [
      'too many embeds',
      Array.from({ length: 11 }, () => '```html-embed\n<p>x</p>\n```').join(
        '\n\n'
      ),
    ],
    ['footnotes', 'Text with a note[^1].\n\n[^1]: The note.'],
    ['empty', ''],
    ['whitespace', '   \n\n  \n'],
    ['unicode', 'é 中文 😀 ​ zero-width and RTL שלום'],
    [
      'mixed',
      '# Notes\n\nSome **bold** text.\n\n- item with `code` and $m$\n- [link](https://x.test)\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n| k | v |\n|---|---|\n| a | 1 |\n\n> tip: quote\n\n```quiz\nquestions:\n  - id: q1\n    labels: letters\n```',
    ],
    [
      'mdx-ish',
      '<Callout type="info">Hello</Callout>\n\n{1 + 1}\n\nimport x from "y"',
    ],
    ['long paragraph', 'word '.repeat(5000)],
    // Agent markdown is read without MDX (main 7719d357): fence bodies keep
    // every character, `{}` and `<` stay text, a four-space line is code, a
    // fence that is not YAML is refused; figures stay assets (142ca296).
    [
      'html embed keeps its source',
      '```html-embed\ncaption: Loop\nhtml: |\n  <label for="n" class="k">n</label>\n  <script>for(var i=0;i<3;i++){var b=i}</script>\n```\n\nProse with {2, 3} and a stray < sign.',
    ],
    ['html embed not yaml', '```html-embed\ncaption: [unclosed\nhtml: x\n```'],
    ['indented code', 'Para\n\n    four spaces\n    more\n\nafter'],
    ['figure image', '![A leaf cross-section](figure:fig_123)\n\nText ![other](https://x.test/b.png)'],
    [
      'deep list',
      Array.from(
        { length: 12 },
        (_, i) => `${'  '.repeat(i)}- level ${i}`
      ).join('\n'),
    ],
  ];
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) pages.push(path);
    }
  };
  for (const dir of ['openwiki', 'human']) walk(dir);
  for (const file of [
    'README.md',
    'collaboration/README.md',
    'todo-office.md',
    'todo-learning.md',
    'bench/README.md',
  ])
    pages.push(file);
  const cases: unknown[] = [];
  const timings: number[] = [];
  for (const [name, source] of [
    ...samples,
    ...pages
      .sort()
      .map((page): [string, string] => [
        page,
        readFileSync(join(root, page), 'utf8'),
      ]),
  ]) {
    const start = performance.now();
    let result: unknown;
    try {
      result = await convertAgentMarkdown(source);
    } catch (error) {
      result = { error: (error as Error).message };
    }
    timings.push(performance.now() - start);
    cases.push({ name, result, source });
  }
  write('markdown', cases, true);
  // biome-ignore lint/suspicious/noConsole: the Node timing for the report.
  console.log(
    `markdown: ${cases.length} sources, Node convert total ${timings.reduce((a, b) => a + b, 0).toFixed(0)} ms (first ${timings[0].toFixed(0)} ms, including the bundle load)`
  );
}

/* ------------------------------------------------------------------- main */

const finals: { name: string; state: Uint8Array }[] = [];
const families = new Set(
  (process.env.CORPUS_FAMILIES ?? 'projection,ops').split(',')
);

if (families.has('ops')) {
  for (const [name, value] of Object.entries(smallNotes)) {
    for (const seed of [1, 2, 3]) {
      finals.push(
        opsFamily({
          name: `small-${name}-${seed}`,
          peer: seed === 3,
          seed,
          steps: 150,
          syncEvery: seed === 3 ? 10 : undefined,
          value: withIds(value),
          values: true,
        })
      );
    }
  }
  finals.push(
    opsFamily({
      name: 'seed-notes',
      peer: true,
      seed: 4,
      steps: 150,
      syncEvery: 15,
      value: withIds(seedNotes.flatMap((note) => note.value)),
    })
  );
  finals.push(
    opsFamily({ name: 'load-note', seed: 1, steps: 120, value: loadNote })
  );
  finals.push(
    opsFamily({
      name: 'over-limit',
      seed: 2,
      steps: 24,
      value: [...loadNote, paragraph('y'.repeat(120_000))],
    })
  );
}
if (families.has('multi'))
  for (const seed of [1, 2, 3, 4, 5, 6]) multiWriterFamily(seed, 600);
if (families.has('projection')) projectionFamily(finals);
if (families.has('validation')) validationFamily();
if (families.has('edits')) editsFamily();
if (families.has('children')) childrenFamily();
if (families.has('commands')) commandsFamily();
if (families.has('inspect')) inspectFamily();
if (families.has('markdown')) await markdownFamily();
if (families.has('bootstrap')) {
  // `load`'s first open: materials.content into a fresh document.
  const values: [string, unknown[]][] = [
    ['load-note', loadNote],
    ...seedNotes.map((note): [string, unknown[]] => [note.id, note.value]),
    ...Object.entries(smallNotes),
  ];
  write(
    'bootstrap',
    values.map(([name, value]) => ({
      name,
      state: b64(Y.encodeStateAsUpdate(docWithValue(value, 5))),
      value,
    })),
    true
  );
}
