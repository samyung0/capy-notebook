import { expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  type ElementEntry,
  keyedElements,
  readElements,
  writeElements,
} from './keyed';
import type { GraphElement } from './model';

const point = (id: string, x: number): GraphElement => ({
  coords: [x, 0],
  id,
  type: 'point',
});

/** A map in a document, holding `list`, and the keys each later change touches. */
function stored(list: GraphElement[]) {
  const doc = new Y.Doc();
  const map = doc.getMap<ElementEntry<GraphElement>>('elements');
  for (const [id, entry] of Object.entries(keyedElements(list)))
    map.set(id, entry);
  const touched: string[][] = [];
  map.observe((event) => touched.push([...event.keysChanged].sort()));
  const write = (next: GraphElement[]) =>
    doc.transact(() => writeElements(map, next));
  return { map, touched, write };
}

it('reads elements by order key, then by id', () => {
  const entries: [string, ElementEntry][] = [
    ['b', { element: point('b', 1), order: 'a1' }],
    ['c', { element: point('c', 2), order: 'a0' }],
    ['a', { element: point('a', 3), order: 'a1' }],
  ];
  expect(readElements(entries).map(({ id }) => id)).toEqual(['c', 'a', 'b']);
});

it('writes only the elements that changed', () => {
  const [a, b, c] = [point('a', 0), point('b', 1), point('c', 2)];
  const { map, touched, write } = stored([a, b, c]);
  const moved = point('b', 5);
  const added = point('d', 3);
  write([a, moved, added]);
  expect(touched).toEqual([['b', 'c', 'd']]);
  // The new one goes last; the kept ones keep their place.
  expect(readElements(map.entries())).toEqual([a, moved, added]);
  write(readElements(map.entries()));
  expect(touched).toHaveLength(1);
});

it('appends after a gap keeping every held key, writing only the new entry', () => {
  const [p, x, q] = [point('p', 0), point('x', 1), point('q', 2)];
  const { map, touched, write } = stored([p, x, q]);
  write([p, q]);
  const r = point('r', 3);
  write([p, q, r]);
  expect(touched.at(-1)).toEqual(['r']);
  expect(map.get('q')?.order).toBe('a2');
  expect(readElements(map.entries())).toEqual([p, q, r]);
});

it("keys any item with an id, as a canvas chart's bars", () => {
  const bar = (id: string, value: number) => ({ id, label: id, value });
  const map = new Map<string, ElementEntry<ReturnType<typeof bar>>>();
  writeElements(map, [bar('a', 1), bar('b', 2)]);
  const held = map.get('b');
  writeElements(map, [bar('a', 3), bar('b', 2)]);
  expect(map.get('b')).toBe(held);
  expect(readElements(map.entries())).toEqual([bar('a', 3), bar('b', 2)]);
});

it('keeps the stored object for an equal fresh copy, and writes a move as one entry', () => {
  const [a, b, c] = [point('a', 0), point('b', 1), point('c', 2)];
  const { map, touched, write } = stored([a, b, c]);
  write([a, b, c].map((element) => structuredClone(element)));
  expect(touched).toEqual([]);
  expect(map.get('a')?.element).toBe(a);
  write([c, a, b]);
  expect(touched).toEqual([['c']]);
  expect(readElements(map.entries())).toEqual([c, a, b]);
});

/** A document with the given Yjs client id, and a writer that hands
 * `writeElements` a change of its own read, returning the keys it touched. */
function peer(client: number) {
  const doc = new Y.Doc();
  doc.clientID = client;
  const map = doc.getMap<ElementEntry<GraphElement>>('elements');
  const write = (change: (list: GraphElement[]) => GraphElement[]) => {
    const touched: string[] = [];
    const record = (event: Y.YMapEvent<ElementEntry<GraphElement>>) =>
      touched.push(...event.keysChanged);
    map.observe(record);
    doc.transact(() => writeElements(map, change(readElements(map.entries()))));
    map.unobserve(record);
    return touched.sort();
  };
  return { doc, map, write };
}

/** Exchanges what each document lacks. */
function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

it.each([
  [1, 2],
  [2, 1],
])(
  'keeps a peer edit to an element a tie of two adds left (client ids %i, %i)',
  (first, second) => {
    const a = peer(first);
    const b = peer(second);
    const held = [point('b1', 1), point('b2', 2), point('b3', 3)];
    a.doc.transact(() => {
      for (const [id, entry] of Object.entries(keyedElements(held)))
        a.map.set(id, entry);
    });
    sync(a.doc, b.doc);
    // Both add at the end at once: b4 and b5 take the same key.
    a.write((list) => [...list, point('b4', 4)]);
    b.write((list) => [...list, point('b5', 5)]);
    sync(a.doc, b.doc);
    const changed = point('b1', 10);
    const renamed: GraphElement = {
      coords: [4, 0],
      id: 'b4',
      name: 'Four',
      type: 'point',
    };
    const touched = a.write((list) =>
      list.map((element) => (element.id === 'b1' ? changed : element))
    );
    b.write((list) =>
      list.map((element) => (element.id === 'b4' ? renamed : element))
    );
    sync(a.doc, b.doc);
    const merged = [changed, held[1], held[2], renamed, point('b5', 5)];
    expect(readElements(a.map.entries())).toEqual(merged);
    expect(readElements(b.map.entries())).toEqual(merged);
    expect(touched).toEqual(['b1']);
  }
);
