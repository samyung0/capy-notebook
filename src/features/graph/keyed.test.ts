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
  const map = doc.getMap<ElementEntry>('elements');
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
