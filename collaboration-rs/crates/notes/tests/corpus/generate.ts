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
import { validateQuestion, validateQuestions } from './questions.js';

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
if (families.has('projection')) projectionFamily(finals);

export {
  applyChildren,
  applyCollaborationCommand,
  applyMaterialCommands,
  applyTextCommands,
  assertCanonicalMaterialValue,
  childWrites,
  EditError,
  inspectMaterial,
  keptIds,
  planChildren,
  readdirSync,
  readFileSync,
  validateQuestion,
  validateQuestions,
  verifyMaterialGuards,
  verifyTextGuards,
};
export type { DocumentCommand, GuardTarget, Operation };
