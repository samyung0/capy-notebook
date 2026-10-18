import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { PIECE_BYTES, splitUpdate } from './pieces';

/**
 * `pieces` applied in order to a copy of `base`: after how many of them
 * something was pending, and the document they made, beside the whole
 * update's (`whole`), which they must equal.
 */
function applyInOrder(base: Y.Doc, update: Uint8Array, pieces: Uint8Array[]) {
  const receiver = new Y.Doc({ gc: false });
  Y.applyUpdate(receiver, Y.encodeStateAsUpdate(base));
  let pending = 0;
  for (const piece of pieces) {
    Y.applyUpdate(receiver, piece);
    if (receiver.store.pendingStructs || receiver.store.pendingDs) pending += 1;
  }
  const whole = new Y.Doc({ gc: false });
  Y.applyUpdate(whole, Y.encodeStateAsUpdate(base));
  Y.applyUpdate(whole, update);
  return {
    receiver,
    result: { pending, state: Y.encodeStateAsUpdate(receiver) },
    whole: { pending: 0, state: Y.encodeStateAsUpdate(whole) },
  };
}

const synced = (from: Y.Doc, to: Y.Doc) =>
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));

it('sends an update within the limit as it is', () => {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, 'hello');
  const update = Y.encodeStateAsUpdate(doc);
  expect(splitUpdate(update)).toEqual([update]);
  expect(PIECE_BYTES).toBe(2 * 1024 * 1024);
});

it('cuts a local edit of many paragraphs into ordered pieces under the limit', () => {
  const base = new Y.Doc();
  const root = base.get('content', Y.XmlText);
  root.insert(0, 'base');
  const editor = new Y.Doc();
  synced(base, editor);
  let update: Uint8Array = new Uint8Array();
  editor.on('update', (next: Uint8Array) => {
    update = next;
  });
  editor.transact(() => {
    const content = editor.get('content', Y.XmlText);
    for (let index = 0; index < 200; index += 1) {
      const block = new Y.XmlText();
      content.insertEmbed(content.length, block, { type: 'p' });
      block.insert(0, `paragraph ${index} `.repeat(20));
      block.format(0, 9, { bold: true });
    }
    content.delete(0, 2);
  });
  const pieces = splitUpdate(update, 4096);
  expect(pieces.length).toBeGreaterThan(10);
  for (const piece of pieces)
    expect(piece.byteLength).toBeLessThanOrEqual(4096);
  const { receiver, result, whole } = applyInOrder(base, update, pieces);
  expect(result).toEqual(whole);
  expect(receiver.get('content', Y.XmlText).toString()).toBe(
    editor.get('content', Y.XmlText).toString()
  );
});

/**
 * A reconnect's step 2: everything three sessions wrote while the server held
 * only the base, their edits built on each other's (a resync diff of several
 * clients), with deletions of base and diff items. Pieces as small as a few
 * structs still apply in order, each with nothing pending.
 */
it('cuts a resync diff of several clients so each piece applies in order', () => {
  const server = new Y.Doc();
  server.getText('t').insert(0, 'base text that everyone edits');
  server.getArray<number>('a').push([1, 2, 3]);
  server.getMap('m').set('k', 'v');
  const peers = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
  for (const peer of peers) synced(server, peer);
  // Interleaved rounds: each peer edits, then hears the others, so later
  // inserts name items of other clients as origins.
  for (let round = 0; round < 12; round += 1) {
    for (const [index, peer] of peers.entries()) {
      const text = peer.getText('t');
      text.insert(
        (round * 7 + index * 3) % (text.length + 1),
        `p${index}r${round} `
      );
      if (round % 3 === 2) text.delete(Math.min(2, text.length - 1), 1);
      peer.getArray<number>('a').insert(0, [round * 10 + index]);
      peer.getMap('m').set(`k${index}`, { round, text: 'x'.repeat(round * 5) });
      const nested = new Y.Map<string>();
      peer.getArray<unknown>('nested').push([nested]);
      nested.set('inside', `from ${index} in ${round}`);
    }
    for (const from of peers)
      for (const to of peers) if (from !== to) synced(from, to);
  }
  const client = peers[0];
  const diff = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
  expect(Y.decodeUpdate(diff).structs.map((s) => s.id.client)).toEqual(
    expect.arrayContaining(peers.map((peer) => peer.clientID))
  );
  for (const limit of [200, 600, 2048]) {
    const pieces = splitUpdate(diff, limit);
    expect(pieces.length).toBeGreaterThan(1);
    const { receiver, result, whole } = applyInOrder(server, diff, pieces);
    expect(result).toEqual(whole);
    expect(receiver.getText('t').toString()).toBe(
      client.getText('t').toString()
    );
    expect(receiver.getArray('nested').toJSON()).toEqual(
      client.getArray('nested').toJSON()
    );
  }
});

it('cuts one long text item into runs, keeping surrogate pairs whole', () => {
  const base = new Y.Doc();
  base.getText('t').insert(0, '[]');
  const editor = new Y.Doc();
  synced(base, editor);
  // One insert: a single item whose cut points fall inside emoji pairs.
  const long = '😀ab'.repeat(5000);
  let update: Uint8Array = new Uint8Array();
  editor.on('update', (next: Uint8Array) => {
    update = next;
  });
  editor.getText('t').insert(1, long);
  expect(Y.decodeUpdate(update).structs).toHaveLength(1);
  const pieces = splitUpdate(update, 3000);
  expect(pieces.length).toBeGreaterThan(5);
  for (const piece of pieces)
    expect(piece.byteLength).toBeLessThanOrEqual(3000);
  const { receiver, result, whole } = applyInOrder(base, update, pieces);
  expect(result).toEqual(whole);
  expect(receiver.getText('t').toString()).toBe(`[${long}]`);
});

it('cuts a long run of values, and sends what cannot be cut whole', () => {
  const base = new Y.Doc();
  const editor = new Y.Doc();
  let update: Uint8Array = new Uint8Array();
  editor.on('update', (next: Uint8Array) => {
    update = next;
  });
  const photo = new Uint8Array(10_000).map((_, index) => index % 251);
  editor.transact(() => {
    editor.getArray<unknown>('cells').push(
      Array.from({ length: 2000 }, (_, index) => ({
        cell: index,
        value: 'v'.repeat(10),
      }))
    );
    editor.getMap<Uint8Array>('images').set('photo', photo);
  });
  const pieces = splitUpdate(update, 4000);
  // The 10 KB binary is one piece of its own, over the limit.
  expect(pieces.filter((piece) => piece.byteLength > 4000)).toHaveLength(1);
  const { receiver, result, whole } = applyInOrder(base, update, pieces);
  expect(result).toEqual(whole);
  expect(receiver.getArray('cells').length).toBe(2000);
  expect(receiver.getMap('images').get('photo')).toEqual(photo);
});

it('sends a delete set larger than a piece in pieces after the structs', () => {
  const base = new Y.Doc();
  const text = base.getText('t');
  // Separate items (one per insert), every other one deleted below.
  for (let index = 0; index < 3000; index += 1) text.insert(index, 'x');
  const editor = new Y.Doc();
  synced(base, editor);
  let update: Uint8Array = new Uint8Array();
  editor.on('update', (next: Uint8Array) => {
    update = next;
  });
  editor.transact(() => {
    const edited = editor.getText('t');
    for (let index = edited.length - 2; index >= 0; index -= 2)
      edited.delete(index, 1);
  });
  const pieces = splitUpdate(update, 1000);
  expect(pieces.length).toBeGreaterThan(1);
  const { receiver, result, whole } = applyInOrder(base, update, pieces);
  expect(result).toEqual(whole);
  expect(receiver.getText('t').length).toBe(1500);
});
