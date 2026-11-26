import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { collectedSize } from './collectedSize';

const encoded = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc).byteLength;

/** What a fresh collected copy of `doc` holds, as the room's state does. */
function collectedCopy(doc: Y.Doc) {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return encoded(copy);
}

/** A document whose map `blocks` an undo history tracks, as a board's is. */
function tracked() {
  const doc = new Y.Doc();
  const blocks = doc.getMap<unknown>('blocks');
  const history = new Y.UndoManager(blocks);
  return { blocks, doc, history };
}

/** A stroke as the board writes one, its points `points` long. */
function stroke(x: number, points: number) {
  const element = new Y.Map<unknown>();
  element.set('type', 'brush');
  element.set('xywh', `[${x},0,10,10]`);
  element.set('points', 'p'.repeat(points));
  return element;
}

const shapes: [string, () => Y.Doc][] = [
  [
    'map entries, all deleted',
    () => {
      const { blocks, doc } = tracked();
      doc.transact(() => {
        for (let at = 0; at < 200; at++) blocks.set(`e${at}`, 'x'.repeat(2000));
      });
      doc.transact(() => blocks.clear());
      return doc;
    },
  ],
  [
    'nested maps, some deleted with what they hold',
    () => {
      const { blocks, doc } = tracked();
      doc.transact(() => {
        for (let at = 0; at < 50; at++) {
          const block = new Y.Map<unknown>();
          blocks.set(`b${at}`, block);
          for (let key = 0; key < 10; key++)
            block.set(`k${key}`, 'v'.repeat(200));
          block.set('inner', new Y.Map([['deep', 'd'.repeat(300)]]));
        }
      });
      doc.transact(() => {
        for (let at = 0; at < 30; at++) blocks.delete(`b${at}`);
      });
      return doc;
    },
  ],
  [
    'a text with deleted characters',
    () => {
      const { blocks, doc } = tracked();
      const text = new Y.Text();
      blocks.set('note', text);
      for (let at = 0; at < 50; at++) text.insert(text.length, 'w'.repeat(100));
      for (let at = 4900; at > 0; at -= 200) text.delete(at, 100);
      return doc;
    },
  ],
  [
    'a board partly erased, its strokes moved',
    () => {
      const { blocks, doc } = tracked();
      const elements = new Y.Map<Y.Map<unknown>>();
      blocks.set('surface', elements);
      for (let at = 0; at < 300; at++)
        doc.transact(() => elements.set(`s${at}`, stroke(at, 600)));
      for (let at = 0; at < 300; at += 3)
        elements.get(`s${at}`)?.set('xywh', `[${at},20,10,10]`);
      doc.transact(() => {
        for (let at = 0; at < 150; at++) elements.delete(`s${at * 2}`);
      });
      return doc;
    },
  ],
];

// The CI run of canvas-room-states.spec.ts: an undo history keeps what its
// transactions deleted, so the encode still holds it while the room's state
// is collected. The measure is never below what a collected copy holds (the
// full line never lets a board past the room's cap) and comes well under the
// encode.
it.each(shapes)(
  'sizes %s at or above a collected copy, under the encode',
  (_, make) => {
    const doc = make();
    const size = collectedSize(doc);
    expect(size).toBeGreaterThanOrEqual(collectedCopy(doc));
    expect(size).toBeLessThan(encoded(doc));
  }
);

it('takes an encode below where the size is acted on as it is, with no walk', () => {
  const [, make] = shapes[0];
  const doc = make();
  const size = encoded(doc);
  expect(collectedSize(doc, size + 1)).toBe(size);
  expect(collectedSize(doc, size)).toBeLessThan(size);
});

it('sizes a document with nothing kept of its deletions as its encode', () => {
  const doc = new Y.Doc();
  const blocks = doc.getMap<unknown>('blocks');
  for (let at = 0; at < 20; at++) blocks.set(`e${at}`, 'x'.repeat(500));
  for (let at = 0; at < 10; at++) blocks.delete(`e${at}`);
  expect(collectedSize(doc)).toBe(encoded(doc));
});
