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
