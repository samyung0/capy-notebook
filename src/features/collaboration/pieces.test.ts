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

/** A note of paragraphs written as slate-yjs writes elements (the type, its
 * properties, its text), with `insert` added between them in a transaction
 * of its own (the element it returns, or what it writes into the content):
 * the whole state and the clocks [from, to) that insert took. */
function noteAround(insert: (content: Y.XmlText) => Y.XmlText | undefined) {
  const editor = new Y.Doc();
  const content = editor.get('content', Y.XmlText);
  const paragraphs = (from: number) =>
    editor.transact(() => {
      for (let index = from; index < from + 20; index += 1) {
        const block = new Y.XmlText();
        block.setAttribute('type', 'p');
        block.setAttribute('id', `b${index}`);
        block.insert(0, `line ${index} `.repeat(1 + (index % 7)));
        content.insertEmbed(content.length, block);
      }
    });
  paragraphs(0);
  const from = Y.getState(editor.store, editor.clientID);
  editor.transact(() => {
    const element = insert(content);
    if (element) content.insertEmbed(content.length, element);
  });
  const to = Y.getState(editor.store, editor.clientID);
  paragraphs(20);
  return {
    client: editor.clientID,
    from,
    to,
    update: Y.encodeStateAsUpdate(editor),
  };
}

/** The update cut at every limit from 16 bytes up: the limits where a piece
 * held only part of the client's clocks [from, to), and how many cuts left
 * something pending or ended in another document. */
function cutEverywhere({
  client,
  from,
  to,
  update,
}: ReturnType<typeof noteAround>) {
  const split: number[] = [];
  let wrong = 0;
  for (let limit = 16; limit < update.byteLength; limit += 8) {
    const pieces = splitUpdate(update, limit);
    for (const piece of pieces) {
      let held = 0;
      for (const struct of Y.decodeUpdate(piece).structs) {
        if (struct.id.client !== client) continue;
        const start = Math.max(struct.id.clock, from);
        const end = Math.min(struct.id.clock + struct.length, to);
        held += Math.max(0, end - start);
      }
      if (held !== 0 && held !== to - from) split.push(limit);
    }
    const { result, whole } = applyInOrder(new Y.Doc(), update, pieces);
    if (result.pending || !equalBytes(result.state, whole.state)) wrong += 1;
  }
  return { split, wrong };
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  return a.byteLength === b.byteLength && a.every((byte, at) => byte === b[at]);
}

it('keeps a new chart with its whole figure map and properties in one piece, wherever it is cut', () => {
  // An embed's figure as the editor writes it: the element, its `block` map
  // and everything nested in it, then `id` and `type`.
  const chart = noteAround(() => {
    const element = new Y.XmlText();
    const block = new Y.Map();
    const series = new Y.Array();
    for (let index = 0; index < 30; index += 1) {
      const point = new Y.Map();
      point.set('x', index);
      point.set('label', `quarter ${index} `.repeat(1 + (index % 4)));
      series.push([point]);
    }
    block.set('kind', 'bar');
    block.set('series', series);
    block.set('title', new Y.Text('Revenue by quarter'));
    element.setAttribute('block', block as never);
    element.setAttribute('id', 'chart-1');
    element.setAttribute('type', 'chart');
    return element;
  });
  expect(chart.to - chart.from).toBeGreaterThan(100);
  expect(cutEverywhere(chart)).toEqual({ split: [], wrong: 0 });
});

function series(name: string) {
  const points = new Y.Array();
  for (let index = 0; index < 30; index += 1) {
    const point = new Y.Map();
    point.set('x', index);
    point.set('label', `${name} ${index} `.repeat(1 + (index % 4)));
    points.push([point]);
  }
  return points;
}

// Rate-limit review r3 S3: a resync's state garbage-collects a replaced
// series into structs that name no parent, between the chart's figure and
// its `id` and `type`; the chart still goes in one piece.
it('keeps a chart whose series was replaced in one piece, across its garbage-collected structs', () => {
  const chart = noteAround((content) => {
    const element = new Y.XmlText();
    const block = new Y.Map();
    element.setAttribute('block', block as never);
    content.insertEmbed(content.length, element);
    block.set('series', series('first'));
    block.set('series', series('second'));
    block.set('title', new Y.Text('Revenue by quarter'));
    element.setAttribute('id', 'chart-1');
    element.setAttribute('type', 'chart');
  });
  const { structs } = Y.decodeUpdate(chart.update);
  expect(structs.some((struct) => struct instanceof Y.GC)).toBe(true);
  expect(cutEverywhere(chart)).toEqual({ split: [], wrong: 0 });
});

it('keeps a new Mermaid block with its source text and properties in one piece, wherever it is cut', () => {
  const mermaid = noteAround(() => {
    const element = new Y.XmlText();
    element.setAttribute(
      'source',
      new Y.Text('graph TD\n' + 'A --> B\n'.repeat(60)) as never
    );
    element.setAttribute('id', 'mermaid-1');
    element.setAttribute('type', 'mermaid');
    const caption = new Y.XmlText();
    caption.setAttribute('type', 'mermaid_caption');
    caption.insert(0, 'The flow');
    element.insertEmbed(0, caption);
    return element;
  });
  expect(cutEverywhere(mermaid)).toEqual({ split: [], wrong: 0 });
});
