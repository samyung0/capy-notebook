/** Saved boards for the board's unit tests. */
import * as Y from 'yjs';
import { keyedElements } from '@/features/graph/keyed';
import { fromBase64 } from './base64';
import type { PlaneElement } from './boardData';

// A board saved from the dev route: one page, its canvas and an empty plane card.
export const SAVED =
  'AgGQ5Lr6DAAnAI+enrQJCwhlbGVtZW50cwEXj56etAkAJwEGYmxvY2tzCkw0UTFaSC1HQTQBKACPnp60CQALc3lzOmZsYXZvdXIBdwthZmZpbmU6cGFnZScAj56etAkADHN5czpjaGlsZHJlbgAnAI+enrQJAApwcm9wOnRpdGxlAicBBmJsb2NrcwprWi1XOGxlTS00ASgAj56etAkEC3N5czpmbGF2b3VyAXcOYWZmaW5lOnN1cmZhY2UnAI+enrQJBAxzeXM6Y2hpbGRyZW4AJwCPnp60CQQNcHJvcDplbGVtZW50cwEoAI+enrQJBwR0eXBlAXccJGJsb2Nrc3VpdGU6aW50ZXJuYWw6bmF0aXZlJCcAj56etAkHBXZhbHVlAQgAj56etAkCAXcKa1otVzhsZU0tNCcAj56etAkJCktjYldQeWR1OVcBKACPnp60CQsFaW5kZXgBdwJhMCgAj56etAkLBHNlZWQBfY790+QMKACPnp60CQsDZml0AXghAI+enrQJCwVtYXJrcwEoAI+enrQJCwNwcHUBfSkoAI+enrQJCwZyb3RhdGUBfQAoAI+enrQJCwJ4MAF9QSgAj56etAkLBHh5d2gBdw1bMCwwLDgyMCw1MjBdKACPnp60CQsCeTABe0AhwY+cGPnCKACPnp60CQsEdHlwZQF3BXBsYW5lKACPnp60CQsCaWQBdwpLY2JXUHlkdTlXAY+enrQJAQ8B';

/** A plane's elements as the card stores them: a map of id to element and order key. */
export function planeElements(list: PlaneElement[]) {
  const map = new Y.Map<unknown>();
  for (const [id, entry] of Object.entries(keyedElements(list)))
    map.set(id, entry);
  return map;
}

/** The saved board with more canvas elements. */
export function withElements(...list: Record<string, unknown>[]) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromBase64(SAVED));
  const surface = [...doc.getMap<Y.Map<unknown>>('blocks').values()].find(
    (block) => block.get('sys:flavour') === 'affine:surface'
  );
  const native = surface?.get('prop:elements') as Y.Map<unknown>;
  const elements = native.get('value') as Y.Map<unknown>;
  for (const [i, fields] of list.entries()) {
    const element = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(fields)) element.set(key, value);
    elements.set(String(fields.id ?? `extra${i}`), element);
  }
  return Y.encodeStateAsUpdate(doc);
}

export const withElement = (fields: Record<string, unknown>) =>
  withElements(fields);

/** The saved board with one more block on its canvas: `flavour` and its props. */
export function withCanvasBlock(
  flavour: string,
  props: Record<string, unknown>
) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromBase64(SAVED));
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const surface = [...blocks.values()].find(
    (block) => block.get('sys:flavour') === 'affine:surface'
  );
  const block = new Y.Map<unknown>();
  block.set('sys:id', 'extra');
  block.set('sys:flavour', flavour);
  block.set('sys:children', new Y.Array());
  for (const [key, value] of Object.entries({
    index: 'a1',
    rotate: 0,
    xywh: '[0,0,96,96]',
    ...props,
  }))
    block.set(`prop:${key}`, value);
  blocks.set('extra', block);
  if (!surface) throw new Error('the saved board has no canvas');
  (surface.get('sys:children') as Y.Array<string>).push(['extra']);
  return Y.encodeStateAsUpdate(doc);
}
