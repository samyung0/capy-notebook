import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { holdsBoard } from './boardRoom';

/** A room's blocks as its first state writes them: `page` holding `surface`. */
function room() {
  const doc = new Y.Doc();
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const block = (id: string, flavour: string, children: string[]) => {
    const map = new Y.Map<unknown>();
    map.set('sys:flavour', flavour);
    map.set('sys:children', Y.Array.from(children));
    blocks.set(id, map);
  };
  block('page', 'affine:page', ['surface']);
  block('surface', 'affine:surface', []);
  return doc;
}

// A canvas opens only over what the server's first state wrote: the tab never
// makes a page or a canvas of its own.
it("takes the room's page and canvas, and not a room without them", () => {
  const seeded = room();
  expect(holdsBoard(seeded)).toBe(true);
  expect(holdsBoard(new Y.Doc())).toBe(false);
  // A canvas outside its page is no board either.
  const children = seeded
    .getMap<Y.Map<Y.Array<string>>>('blocks')
    .get('page')
    ?.get('sys:children');
  children?.delete(0, 1);
  expect(holdsBoard(seeded)).toBe(false);
});
