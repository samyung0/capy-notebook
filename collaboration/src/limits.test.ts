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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  MATERIAL_DOCUMENT_LIMITS,
  MaterialDocumentLimitError,
  materialLimitCode,
  materialUpdateGrowth,
  measureMaterialValue,
  recoversMaterialLimits,
} from './limits.js';
import { UPDATE_UNHELD } from './officeRoots.js';
import { YjsDocumentStore } from './persistence.js';
import { scratchDoc } from './scratchDoc.js';

// Counts the room copies validateUpdate makes (each one is a scratch doc).
vi.mock('./scratchDoc.js', { spy: true });
const copies = vi.mocked(scratchDoc);
beforeEach(() => copies.mockClear());

function paragraph(text: string) {
  return { children: [{ text }], type: 'p' };
}

function nestedParagraph(depth: number) {
  let node: Record<string, unknown> = { text: 'bottom' };
  for (let level = 0; level < depth; level += 1) {
    node = { children: [node], type: 'blockquote' };
  }
  return node;
}

function documentWithValue(value: unknown[]) {
  const document = new Y.Doc({ gc: true });
  document
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(value as never));
  return document;
}

function updateReplacingValue(base: Y.Doc, value: unknown[]) {
  const next = new Y.Doc({ gc: true });
  Y.applyUpdate(next, Y.encodeStateAsUpdate(base));
  const content = next.get('content', Y.XmlText);
  content.delete(0, content.length);
  content.applyDelta(slateNodesToInsertDelta(value as never));
  const update = Y.encodeStateAsUpdate(next, Y.encodeStateVector(base));
  next.destroy();
  return update;
}

// Update validation never touches PostgreSQL; only load/store do.
function validator() {
  return new YjsDocumentStore({} as Pool);
}

const room = 'material:abc:schema:1';
// Hocuspocus applies a client's update under this origin; any other content
// change makes the next update measure exactly.
const connection = { source: 'connection' };

describe('material document measurement', () => {
  it('reports depth relative to the top-level blocks', () => {
    const metrics = measureMaterialValue([
      {
        children: [{ children: [{ text: 'deep' }], type: 'p' }],
        type: 'blockquote',
      },
    ]);
    expect(metrics.nodeCount).toBe(3);
    expect(metrics.maxDepth).toBe(2);
    expect(metrics.contentBytes).toBeGreaterThan(0);
  });

  it('measures every node in a structurally valid deep document', () => {
    const metrics = measureMaterialValue([nestedParagraph(300)]);

    expect(metrics.maxDepth).toBe(300);
    expect(metrics.nodeCount).toBe(301);
  });

  it('names the limit that a document breaks', () => {
    expect(
      materialLimitCode(measureMaterialValue([paragraph('ok')]))
    ).toBeNull();
    expect(
      materialLimitCode({
        contentBytes: MATERIAL_DOCUMENT_LIMITS.maxContentBytes + 1,
        maxDepth: 1,
        nodeCount: 1,
      })
    ).toBe('document_size_exceeded');
    expect(
      materialLimitCode({
        contentBytes: 1,
        maxDepth: MATERIAL_DOCUMENT_LIMITS.maxDepth + 1,
        nodeCount: 1,
      })
    ).toBe('document_depth_exceeded');
  });

  it('excludes runtime comment marks from persisted content metrics', () => {
    const clean = [
      {
        children: [{ bold: true, commentary: 'kept', text: 'annotated' }],
        id: 'block_1',
        type: 'p',
      },
    ];
    const runtimeMarked = [
      {
        children: [
          {
            bold: true,
            comment: 'discussion_1',
            comment_thread_1: true,
            commentary: 'kept',
            text: 'annotated',
          },
        ],
        id: 'block_1',
        type: 'p',
      },
    ];

    expect(measureMaterialValue(runtimeMarked)).toEqual(
      measureMaterialValue(clean)
    );
  });
});

describe('recovering an over-limit document', () => {
  const previous = { contentBytes: 100, maxDepth: 4, nodeCount: 10 };

  it('accepts an edit that does not worsen any dimension', () => {
    expect(
      recoversMaterialLimits(
        { contentBytes: 90, maxDepth: 4, nodeCount: 9 },
        previous
      )
    ).toBe(true);
    expect(recoversMaterialLimits(previous, previous)).toBe(true);
  });

  it('rejects an edit that worsens a single dimension', () => {
    expect(
      recoversMaterialLimits(
        { contentBytes: 90, maxDepth: 5, nodeCount: 9 },
        previous
      )
    ).toBe(false);
  });

  it('rejects anything without a baseline to compare against', () => {
    expect(recoversMaterialLimits(previous, null)).toBe(false);
  });
});

describe('inbound update validation', () => {
  it('rejects arbitrary top-level Yjs roots', () => {
    const store = validator();
    const document = documentWithValue([paragraph('small')]);
    const attacker = new Y.Doc({ gc: true });
    Y.applyUpdate(attacker, Y.encodeStateAsUpdate(document));
    attacker.getText('unmetered').insert(0, 'hidden growth');
    const update = Y.encodeStateAsUpdate(
      attacker,
      Y.encodeStateVector(document)
    );

    expect(() => store.validateUpdate(room, document, update)).toThrow(
      'unsupported collaboration document root: unmetered'
    );

    attacker.destroy();
    document.destroy();
  });

  // Once measured, a keystroke is checked from its own structs, not a copy of
  // the room; the shortcut must still refuse every root violation.
  it('keeps refusing root violations between measurements', () => {
    const store = validator();
    const document = documentWithValue([paragraph('small')]);
    const typing = (edit: (peer: Y.Doc) => void) => {
      const peer = new Y.Doc({ gc: true });
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(document));
      edit(peer);
      const update = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(document));
      peer.destroy();
      return update;
    };
    const insert = (peer: Y.Doc) => {
      const block = peer.get('content', Y.XmlText).toDelta()[0]
        .insert as Y.XmlText;
      block.insert(1, 'x');
    };
    // The first update measures; the next ones take the shortcut.
    for (let index = 0; index < 3; index += 1) {
      const update = typing(insert);
      expect(store.validateUpdate(room, document, update)).toBeUndefined();
      Y.applyUpdate(document, update, connection);
    }
    expect(copies).toHaveBeenCalledTimes(1);
    expect(() =>
      store.validateUpdate(
        room,
        document,
        typing((peer) => peer.getText('unmetered').insert(0, 'x'))
      )
    ).toThrow('unsupported collaboration document root: unmetered');
    expect(() =>
      store.validateUpdate(
        room,
        document,
        typing((peer) => peer.get('content', Y.XmlText).setAttribute('a', 'b'))
      )
    ).toThrow('invalid collaboration content root');
    expect(() =>
      store.validateUpdate(
        room,
        document,
        typing((peer) =>
          peer.getMap('__capy_pending_contributors').set('c', 'd')
        )
      )
    ).not.toThrow();
    expect(() =>
      store.validateUpdate(
        room,
        document,
        typing((peer) =>
          peer.getArray('__capy_pending_contributors').insert(0, ['e'])
        )
      )
    ).toThrow('invalid collaboration contributor root');
    document.destroy();
  });

  it('rejects an update that pushes the document past a limit', () => {
    const store = validator();
    const document = documentWithValue([paragraph('small')]);
    const oversized = Array.from(
      { length: MATERIAL_DOCUMENT_LIMITS.maxNodes },
      (_, index) => paragraph(`block ${index}`)
    );
    const update = updateReplacingValue(document, oversized);
    expect(() => store.validateUpdate(room, document, update)).toThrow(
      MaterialDocumentLimitError
    );
  });

  it('still accepts deletions once the document is already over a limit', () => {
    const store = validator();
    const oversized = Array.from(
      { length: MATERIAL_DOCUMENT_LIMITS.maxNodes + 100 },
      (_, index) => paragraph(`block ${index}`)
    );
    const document = documentWithValue(oversized);
    const update = updateReplacingValue(document, [paragraph('recovered')]);
    expect(() => store.validateUpdate(room, document, update)).not.toThrow();
  });

  it('reports the metrics that caused the rejection', () => {
    const store = validator();
    const document = documentWithValue([paragraph('small')]);
    let depth: unknown[] = [{ children: [{ text: 'bottom' }], type: 'p' }];
    for (
      let level = 0;
      level <= MATERIAL_DOCUMENT_LIMITS.maxDepth;
      level += 1
    ) {
      depth = [{ children: depth, type: 'blockquote' }];
    }
    const update = updateReplacingValue(document, depth);
    try {
      store.validateUpdate(room, document, update);
      expect.unreachable('expected the nesting limit to be enforced');
    } catch (error) {
      expect(error).toBeInstanceOf(MaterialDocumentLimitError);
      expect((error as MaterialDocumentLimitError).code).toBe(
        'document_depth_exceeded'
      );
      expect(
        (error as MaterialDocumentLimitError).metrics.maxDepth
      ).toBeGreaterThan(MATERIAL_DOCUMENT_LIMITS.maxDepth);
    }
  });

  it('rejects deep-branch growth hidden behind otherwise shrinking content', () => {
    const store = validator();
    const document = documentWithValue([
      nestedParagraph(300),
      ...Array.from({ length: 1000 }, (_, index) =>
        paragraph(`discarded sibling ${index}`)
      ),
    ]);
    const update = updateReplacingValue(document, [nestedParagraph(301)]);

    expect(() => store.validateUpdate(room, document, update)).toThrow(
      MaterialDocumentLimitError
    );

    document.destroy();
  });

  // A reconnecting writer types before its sync step 2: the keystroke depends
  // on typing the room never got. It is refused for a resync (the caller
  // sends the room's step 1) instead of copying the room to check it, and the
  // client's step 2, carrying what the room lacks, goes in.
  it('refuses a note update the room cannot place yet, without copying the room', () => {
    const store = validator();
    const document = documentWithValue([paragraph('small')]);
    const client = new Y.Doc({ gc: true });
    Y.applyUpdate(client, Y.encodeStateAsUpdate(document));
    const block = () =>
      client.get('content', Y.XmlText).toDelta()[0].insert as Y.XmlText;
    block().insert(5, ' lost'); // never reached the room
    const vector = Y.encodeStateVector(client);
    block().insert(0, '>');
    const keystroke = Y.encodeStateAsUpdate(client, vector);
    expect(store.validateUpdate(room, document, keystroke)).toBe(UPDATE_UNHELD);
    expect(copies).not.toHaveBeenCalled();
    const step2 = Y.encodeStateAsUpdate(client, Y.encodeStateVector(document));
    expect(store.validateUpdate(room, document, step2)).toBeUndefined();
    Y.applyUpdate(document, step2);
    expect(document.store.pendingStructs).toBeNull();
    expect(
      (
        document.get('content', Y.XmlText).toDelta()[0].insert as Y.XmlText
      ).toString()
    ).toBe('>small lost');
    client.destroy();
    document.destroy();
  });
});

// The near-limit note the editor bench opens (src/mocks/noteContent). Imported
// by path at run time: the collaboration build does not compile frontend code.
const LOAD_TEST_NOTE = '../../src/mocks/noteContent/loadTest.ts';
async function loadTestNote() {
  const { buildBiologyLoadTestValue } = (await import(LOAD_TEST_NOTE)) as {
    buildBiologyLoadTestValue: () => unknown[];
  };
  return buildBiologyLoadTestValue();
}

function exactMetrics(document: Y.Doc) {
  const root = yTextToSlateElement(document.get('content', Y.XmlText));
  return measureMaterialValue(root.children);
}

function copyOf(document: Y.Doc) {
  const copy = new Y.Doc({ gc: true });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
  return copy;
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

const INLINE_TYPES = new Set(['a', 'inline_equation', 'mention']);

/**
 * A Slate editor on its own copy of the room, as a browser holds one. Each
 * step runs one random Slate operation (with Slate's normalization) and
 * returns the Yjs update it produced.
 */
function slateClient(room: Y.Doc, random: () => number) {
  const document = copyOf(room);
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
  const point = (path = pick(texts())) => ({
    offset: Math.floor(
      random() * ((Node.get(editor, path) as Text).text.length + 1)
    ),
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
  ];
  const paragraph = (text: string, mark = {}) => ({
    children: [{ text, ...mark }],
    type: 'p',
  });
  const nested = (depth: number): Descendant => {
    let node: Record<string, unknown> = paragraph(word(4));
    for (let level = 0; level < depth; level += 1)
      node = { children: [node], type: 'blockquote' };
    return node as unknown as Descendant;
  };
  const table = (rows: number, columns: number) => ({
    children: Array.from({ length: rows }, () => ({
      children: Array.from({ length: columns }, () => ({
        children: [paragraph(word(3))],
        type: 'td',
      })),
      type: 'tr',
    })),
    type: 'table',
  });
  const blocks = (): Descendant[] =>
    pick([
      () => [paragraph(word(count(200)))],
      // A paste large enough to cross the size limit from near it.
      () => [paragraph('x'.repeat(count(30_000)), pick(marks))],
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
          type: 'p',
        },
      ],
      () => [table(count(12), count(12))],
      () => [nested(count(20))],
      () => Array.from({ length: count(20) }, () => paragraph(word(count(40)))),
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
      Transforms.insertNodes(editor, [paragraph('y'.repeat(count(60_000)))], {
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
      YjsEditor.flushLocalChanges(editor);
      const update = pending.length > 0 ? Y.mergeUpdates(pending) : null;
      pending.length = 0;
      return update;
    },
  };
}

/**
 * Runs random Slate operations against the room and checks each update
 * against an exact measurement of the room after it: the growth bound never
 * under-estimates, and validateUpdate refuses exactly when the candidate
 * breaks a limit without recovering towards the room's exact metrics.
 */
function fuzzRoom(document: Y.Doc, steps: number, seed: number) {
  const random = seeded(seed);
  const store = validator();
  const content = document.get('content', Y.XmlText);
  let client = slateClient(document, random);
  let shadow = copyOf(document);
  let previous = exactMetrics(document);
  const seen = { accepted: 0, exact: 0, refused: 0, unbounded: 0 };
  // Each step that breaks a property, with what it saw.
  const failures: string[] = [];
  for (let index = 0; index < steps; index += 1) {
    const update = client.step();
    if (!update) continue;
    const growth = materialUpdateGrowth(content, update);
    Y.applyUpdate(shadow, update);
    const candidate = exactMetrics(shadow);
    const fail = (what: string) =>
      failures.push(
        `step ${index} (seed ${seed}): ${what} ${JSON.stringify({ candidate, growth, previous })}`
      );
    if (!growth) seen.unbounded += 1;
    else if (
      candidate.contentBytes - previous.contentBytes > growth.contentBytes ||
      candidate.nodeCount - previous.nodeCount > growth.nodeCount ||
      candidate.maxDepth > Math.max(previous.maxDepth, growth.maxDepth)
    )
      fail('bound below the exact growth');
    const code = materialLimitCode(candidate);
    const refuses =
      code !== null && !recoversMaterialLimits(candidate, previous);
    const copiesBefore = copies.mock.calls.length;
    let refusal: unknown = null;
    try {
      store.validateUpdate(room, document, update);
    } catch (error) {
      refusal = error;
    }
    if (copies.mock.calls.length > copiesBefore) seen.exact += 1;
    if (!refuses) {
      if (refusal) fail(`refused (${String(refusal)})`);
      Y.applyUpdate(document, update, connection);
      previous = candidate;
      seen.accepted += 1;
      continue;
    }
    if (
      !(refusal instanceof MaterialDocumentLimitError) ||
      refusal.code !== code ||
      JSON.stringify(refusal.metrics) !== JSON.stringify(candidate)
    )
      fail(`not refused as ${code} (${String(refusal)})`);
    seen.refused += 1;
    // The client drops its forked document and reopens on the room.
    client.close();
    client = slateClient(document, random);
    shadow.destroy();
    shadow = copyOf(document);
  }
  client.close();
  shadow.destroy();
  return { failures, seen };
}

describe('update growth bound', () => {
  it('bounds random Slate edits of the near-limit note and refuses exactly what an exact check refuses', async () => {
    const document = documentWithValue(await loadTestNote());
    const { failures, seen } = fuzzRoom(document, 120, 1);
    expect(failures).toEqual([]);
    // Every Slate edit is modelled, and the run reaches both outcomes.
    expect(seen.unbounded).toBe(0);
    expect(seen.refused).toBeGreaterThan(0);
    expect(seen.accepted).toBeGreaterThan(seen.exact);
    document.destroy();
  }, 240_000);

  it('keeps an over-limit note editable only towards the limits', async () => {
    const value = await loadTestNote();
    value.push(paragraph('y'.repeat(120_000)));
    const document = documentWithValue(value);
    expect(materialLimitCode(exactMetrics(document))).toBe(
      'document_size_exceeded'
    );
    const { failures, seen } = fuzzRoom(document, 24, 2);
    expect(failures).toEqual([]);
    expect(seen.refused).toBeGreaterThan(0);
    expect(seen.accepted).toBeGreaterThan(0);
    document.destroy();
  }, 240_000);
});

describe('checking updates against the bound', () => {
  // A note one paragraph short of the size limit.
  const nearLimit = () =>
    documentWithValue([
      paragraph('a'.repeat(MATERIAL_DOCUMENT_LIMITS.maxContentBytes - 1000)),
      paragraph('typing here'),
    ]);
  const keystroke = (document: Y.Doc, text = 'x') => {
    const client = copyOf(document);
    const block = client.get('content', Y.XmlText).toDelta()[1]
      .insert as Y.XmlText;
    block.insert(5, text);
    const update = Y.encodeStateAsUpdate(client, Y.encodeStateVector(document));
    client.destroy();
    return update;
  };

  it('types near the size limit without copying the room', () => {
    const store = validator();
    const document = nearLimit();
    for (let index = 0; index < 50; index += 1) {
      const update = keystroke(document);
      store.validateUpdate(room, document, update);
      Y.applyUpdate(document, update, connection);
    }
    expect(copies).toHaveBeenCalledTimes(1);
    // Past the limit the bound gives way to the exact check, which refuses.
    expect(() =>
      store.validateUpdate(
        room,
        document,
        keystroke(document, 'z'.repeat(1000))
      )
    ).toThrow(MaterialDocumentLimitError);
    document.destroy();
  });

  it('measures exactly after a content change no update check saw', () => {
    const store = validator();
    const document = nearLimit();
    let update = keystroke(document);
    store.validateUpdate(room, document, update);
    Y.applyUpdate(document, update, connection);
    // A service edit applies outside the client protocol.
    Y.applyUpdate(document, keystroke(document, 'agent'), 'service-edit');
    update = keystroke(document);
    store.validateUpdate(room, document, update);
    expect(copies).toHaveBeenCalledTimes(2);
    document.destroy();
  });

  it('measures exactly after two updates were checked before either applied', () => {
    const store = validator();
    const document = nearLimit();
    const first = keystroke(document);
    store.validateUpdate(room, document, first);
    Y.applyUpdate(document, first, connection);
    // Two writers' updates, both checked against the same room.
    const second = keystroke(document, 'b');
    const third = keystroke(document, 'c');
    store.validateUpdate(room, document, second);
    store.validateUpdate(room, document, third);
    Y.applyUpdate(document, second, connection);
    Y.applyUpdate(document, third, connection);
    expect(copies).toHaveBeenCalledTimes(1);
    store.validateUpdate(room, document, keystroke(document));
    expect(copies).toHaveBeenCalledTimes(2);
    document.destroy();
  });

  it("keeps the bound through Yjs's cleanup of redundant formats", () => {
    const store = validator();
    const document = documentWithValue([paragraph('formatted text')]);
    const bold = () => {
      const client = copyOf(document);
      (
        client.get('content', Y.XmlText).toDelta()[0].insert as Y.XmlText
      ).format(0, 9, { bold: true });
      return client;
    };
    // Two writers bold the same word concurrently; the room then drops the
    // duplicate format items in a transaction of its own.
    const writers = [bold(), bold()];
    const cleanups: Y.Transaction[] = [];
    document.on('afterTransaction', (transaction: Y.Transaction) => {
      if (transaction.origin === null && transaction.deleteSet.clients.size > 0)
        cleanups.push(transaction);
    });
    for (const writer of writers) {
      const update = Y.encodeStateAsUpdate(
        writer,
        Y.encodeStateVector(document)
      );
      store.validateUpdate(room, document, update);
      Y.applyUpdate(document, update, connection);
    }
    expect(cleanups.length).toBeGreaterThan(0);
    const client = copyOf(document);
    (client.get('content', Y.XmlText).toDelta()[0].insert as Y.XmlText).insert(
      3,
      'x'
    );
    store.validateUpdate(
      room,
      document,
      Y.encodeStateAsUpdate(client, Y.encodeStateVector(document))
    );
    expect(copies).toHaveBeenCalledTimes(1);
    document.destroy();
  });
});
