import { expect, it } from 'vitest';
import * as Y from 'yjs';

// The yjs patch's redo rule (patches/yjs@13.6.31.patch, `redoItem`): a
// restored list item keeps the right neighbour its trace finds only when it
// lies after its left, else takes the item now after the left; the check walks
// at most 4,096 items.

type Op = { insert: unknown };

function paragraphs(doc: Y.Doc) {
  return doc
    .get('content', Y.XmlText)
    .toDelta()
    .filter((op: Op) => op.insert instanceof Y.XmlText)
    .map((op: Op) => String(op.insert));
}

function first(doc: Y.Doc) {
  return doc
    .get('content', Y.XmlText)
    .toDelta()
    .find((op: Op) => op.insert instanceof Y.XmlText).insert as Y.XmlText;
}

function load(update: Uint8Array, clientID?: number) {
  const doc = new Y.Doc();
  if (clientID) doc.clientID = clientID;
  doc.get('content', Y.XmlText);
  Y.applyUpdate(doc, update);
  return doc;
}

/** Each document, then a document loaded from each one's state. */
function withReloads(docs: Y.Doc[]) {
  return [...docs, ...docs.map((doc) => load(Y.encodeStateAsUpdate(doc)))];
}

function sync(from: Y.Doc, to: Y.Doc) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

/** A paragraph holding `text` from client 1, and a writer (client 15) with an
 * Undo manager over its own edits. */
function setup(text: string, edit?: (paragraph: Y.XmlText) => void) {
  const seed = new Y.Doc();
  seed.clientID = 1;
  const paragraph = new Y.XmlText();
  seed.get('content', Y.XmlText).insertEmbed(0, paragraph);
  paragraph.insert(0, text);
  edit?.(paragraph);
  const writer = load(Y.encodeStateAsUpdate(seed), 15);
  const undo = new Y.UndoManager(writer.get('content', Y.XmlText), {
    captureTimeout: 0,
    trackedOrigins: new Set(['local']),
  });
  const local = (edit: () => void) => writer.transact(edit, 'local');
  return { local, seed, undo, writer };
}

it('restores a deleted paragraph holding a split copy alike on every replica', () => {
  const { local, seed, undo, writer } = setup('abcdef');
  const peer = load(Y.encodeStateAsUpdate(seed), 30);

  local(() => first(writer).delete(2, 4)); // "ab"
  undo.undo(); // a copy of "cdef" comes back
  local(() => first(writer).insert(4, 'X')); // "abcdXef": the copy splits
  local(() => writer.get('content', Y.XmlText).delete(0, 1)); // the paragraph goes
  undo.undo(); // it comes back with its pieces

  sync(writer, peer);
  // Unpatched, the peer and the writer's reload read "abefcdX".
  for (const doc of withReloads([writer, peer])) {
    expect(paragraphs(doc)).toEqual(['abcdXef']);
  }
});

it('places a restored item after its left once the right walk passes its bound', () => {
  // "acb" as three items; a peer with a lower client id (the seed) puts
  // 5,000 items between the restored "a" and "b" before "c" comes back.
  const { local, seed, undo, writer } = setup('ab', (paragraph) =>
    paragraph.insert(1, 'c')
  );
  local(() => first(writer).delete(1, 1)); // step 1: "ab"
  local(() => writer.get('content', Y.XmlText).delete(0, 1)); // step 2
  undo.undo(); // the paragraph comes back holding "ab"
  sync(writer, seed);
  seed.transact(() => {
    const restored = first(seed);
    for (let i = 0; i < 5000; i++) restored.insert(1, 'x');
  });
  sync(seed, writer);
  undo.undo(); // takes back step 1: "c" comes back
  sync(writer, seed);

  // Past the bound "c" takes the item after "a" as its right; an unbounded
  // walk keeps "b", and "c" lands after the peer's items.
  for (const doc of withReloads([writer, seed])) {
    const [text] = paragraphs(doc);
    expect([text.indexOf('c'), text.length]).toEqual([1, 5003]);
  }
});
