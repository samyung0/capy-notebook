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
  type Operation,
  type Path,
  Text,
  Transforms,
} from 'slate';
import * as Y from 'yjs';
import { applyChildren, childWrites, keptIds, planChildren } from './children.js';
import { applyCollaborationCommand } from './commands.js';
import {
  applyMaterialCommands,
  applyTextCommands,
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
import { assertCanonicalMaterialValue } from './materialDocument.js';
import { UPDATE_UNHELD } from './officeRoots.js';
import { YjsDocumentStore } from './persistence.js';
import { type QuestionPolicy, validateQuestion } from './questions.js';

const OUT = process.env.CORPUS_OUT;
if (!OUT) throw new Error('CORPUS_OUT is required');
mkdirSync(OUT, { recursive: true });

/* ---------------------------------------------------------------- helpers */

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function write(name: string, data: unknown, gzip = false) {
  const json = JSON.stringify(data);
  const path = join(OUT as string, gzip ? `${name}.json.gz` : `${name}.json`);
  writeFileSync(path, gzip ? gzipSync(json, { level: 9 }) : `${json}\n`);
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
const { seedNotes } = (await import('../../src/mocks/noteContent/index.ts')) as {
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
        { children: [{ text: '' }], texExpression: 'x^2', type: 'inline_equation' },
        { text: '' },
      ],
      id: 'm2',
      type: 'p',
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
  voids: [
    {
      children: [{ text: '' }],
      id: 'v1',
      materialId: 'mat_q',
      refKind: 'quiz',
      type: 'material_ref',
    },
    { children: [{ text: '' }], id: 'v2', provider: 'youtube', type: 'video', videoId: 'dQw4w9WgXcQ' },
    {
      children: [{ text: '' }],
      html: '<p>"quoted" \\ back</p>',
      id: 'v3',
      title: 'Tangent',
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
    block.insert(0, 'abc', { text: 'shadowed', bold: true });
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
    block.setAttribute('obj', { z: 1, a: { nested: 'x' } });
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
  const characters = ['a', 'b', ' ', 'é', '中', '😀', '"', '\\', '\n', '\u0001'];
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
          block: { kind: 'bar', labels: ['A'], series: [{ name: 'S', values: [1.5] }], title: 'T', type: 'chart' },
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
      Transforms.insertNodes(editor, [para('y'.repeat(count(big ? 60_000 : 600)))], {
        at: block(),
      }),
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
const ROOM_CLIENT = 1_000;

/** Counts the exact path of validateUpdate: it destroys its candidate copy. */
let scratchDestroys = 0;
const destroy = Y.Doc.prototype.destroy;
Y.Doc.prototype.destroy = function (this: Y.Doc) {
  if (this.guid === 'scratch') scratchDestroys += 1;
  return destroy.call(this);
};

interface OpsOptions {
  name: string;
  value: unknown[];
  steps: number;
  seed: number;
  /** A second writer whose updates the Rust side applies as bytes. */
  peer?: boolean;
  /** Steps between peers reopening on the room. */
  syncEvery?: number;
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
  let nextClient = 2_000;
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
  return { name: `ops-final-${options.name}`, state: Y.encodeStateAsUpdate(room) };
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
  let nextClient = 3_000;
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
      zod: /^(invalid material document: )*\[/.test(message),
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
        children: [{ text: '' }],
        html: 'é'.repeat(32_768),
        id: `e${i}`,
        title: 'Tangent',
        type: 'html_embed',
      })),
    },
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
      record(`${base.name} mutation ${index}`, base.kind, mutate(base.value, random));
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

export {
  applyChildren,
  applyCollaborationCommand,
  applyMaterialCommands,
  applyTextCommands,
  childWrites,
  EditError,
  inspectMaterial,
  keptIds,
  planChildren,
  verifyMaterialGuards,
  verifyTextGuards,
};
export type { DocumentCommand, GuardTarget, Operation };
