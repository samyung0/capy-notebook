/** Saved boards for the board's unit tests. */
import * as Y from 'yjs';
import { fromBase64 } from './base64';

// A board saved from the dev route: one page, its canvas and a plane card.
export const SAVED =
  'ARePnp60CQAnAQZibG9ja3MKTDRRMVpILUdBNAEoAI+enrQJAAtzeXM6Zmxhdm91cgF3C2FmZmluZTpwYWdlJwCPnp60CQAMc3lzOmNoaWxkcmVuACcAj56etAkACnByb3A6dGl0bGUCJwEGYmxvY2tzCmtaLVc4bGVNLTQBKACPnp60CQQLc3lzOmZsYXZvdXIBdw5hZmZpbmU6c3VyZmFjZScAj56etAkEDHN5czpjaGlsZHJlbgAnAI+enrQJBA1wcm9wOmVsZW1lbnRzASgAj56etAkHBHR5cGUBdxwkYmxvY2tzdWl0ZTppbnRlcm5hbDpuYXRpdmUkJwCPnp60CQcFdmFsdWUBCACPnp60CQIBdwprWi1XOGxlTS00JwCPnp60CQkKS2NiV1B5ZHU5VwEoAI+enrQJCwVpbmRleAF3AmEwKACPnp60CQsEc2VlZAF9jv3T5AwoAI+enrQJCwNmaXQBeCgAj56etAkLBW1hcmtzAXUAKACPnp60CQsDcHB1AX0pKACPnp60CQsGcm90YXRlAX0AKACPnp60CQsCeDABfUEoAI+enrQJCwR4eXdoAXcNWzAsMCw4MjAsNTIwXSgAj56etAkLAnkwAXtAIcGPnBj5wigAj56etAkLBHR5cGUBdwVwbGFuZSgAj56etAkLAmlkAXcKS2NiV1B5ZHU5VwA=';

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
