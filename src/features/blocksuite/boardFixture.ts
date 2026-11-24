/** Saved boards for the board's unit tests. */
import * as Y from 'yjs';
import { type Keyed, keyedElements } from '@/features/graph/keyed';
import { fromBase64 } from './base64';

// A board saved from the dev route: one page, its canvas and an empty plane card,
// its elements keyed by id.
export const SAVED =
  'ARePnp60CQAnAQZibG9ja3MKTDRRMVpILUdBNAEoAI+enrQJAAtzeXM6Zmxhdm91cgF3C2FmZmluZTpwYWdlJwCPnp60CQAMc3lzOmNoaWxkcmVuAAgAj56etAkCAXcKa1otVzhsZU0tNCcAj56etAkACnByb3A6dGl0bGUCJwEGYmxvY2tzCmtaLVc4bGVNLTQBKACPnp60CQULc3lzOmZsYXZvdXIBdw5hZmZpbmU6c3VyZmFjZScAj56etAkFDHN5czpjaGlsZHJlbgAnAI+enrQJBQ1wcm9wOmVsZW1lbnRzASgAj56etAkIBHR5cGUBdxwkYmxvY2tzdWl0ZTppbnRlcm5hbDpuYXRpdmUkJwCPnp60CQgFdmFsdWUBJwCPnp60CQoKS2NiV1B5ZHU5VwEnAI+enrQJCwhlbGVtZW50cwEoAI+enrQJCwVpbmRleAF3AmEwKACPnp60CQsEc2VlZAF9jv3T5AwoAI+enrQJCwNmaXQBeCgAj56etAkLA3BwdQF9KSgAj56etAkLBnJvdGF0ZQF9ACgAj56etAkLAngwAX1BKACPnp60CQsEeHl3aAF3DVswLDAsODIwLDUyMF0oAI+enrQJCwJ5MAF7QCHBj5wY+cIoAI+enrQJCwR0eXBlAXcFcGxhbmUoAI+enrQJCwJpZAF3CktjYldQeWR1OVcA';

/** A keyed list as a card stores it (a plane's elements, a chart's bars, labels and
 * lines): a map of id to item and order key. */
export function keyedMap<E extends Keyed>(list: E[]) {
  const map = new Y.Map<unknown>();
  for (const [id, entry] of Object.entries(keyedElements(list)))
    map.set(id, entry);
  return map;
}

/** The saved board with more canvas elements, each with its `id` (its key) as
 * BlockSuite writes one. */
export function withElements(...list: Record<string, unknown>[]) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromBase64(SAVED));
  const surface = [...doc.getMap<Y.Map<unknown>>('blocks').values()].find(
    (block) => block.get('sys:flavour') === 'affine:surface'
  );
  const native = surface?.get('prop:elements') as Y.Map<unknown>;
  const elements = native.get('value') as Y.Map<unknown>;
  for (const [i, fields] of list.entries()) {
    const id = String(fields.id ?? `extra${i}`);
    const element = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({ ...fields, id }))
      element.set(key, value);
    elements.set(id, element);
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

/** A saved board with `props` set on its page block (`prop:` + each name). */
export function withPageProps(
  update: Uint8Array,
  props: Record<string, unknown>
) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const page = [...doc.getMap<Y.Map<unknown>>('blocks').values()].find(
    (block) => block.get('sys:flavour') === 'affine:page'
  );
  if (!page) throw new Error('the saved board has no page');
  for (const [key, value] of Object.entries(props))
    page.set(`prop:${key}`, value);
  return Y.encodeStateAsUpdate(doc);
}
