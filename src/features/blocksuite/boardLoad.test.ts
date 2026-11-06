import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { fromBase64 } from './base64';
import { BoardLoadError, checkSavedBoard } from './boardLoad';

// A board saved from the dev route: one page, its canvas and a plane card.
const SAVED =
  'ARePnp60CQAnAQZibG9ja3MKTDRRMVpILUdBNAEoAI+enrQJAAtzeXM6Zmxhdm91cgF3C2FmZmluZTpwYWdlJwCPnp60CQAMc3lzOmNoaWxkcmVuACcAj56etAkACnByb3A6dGl0bGUCJwEGYmxvY2tzCmtaLVc4bGVNLTQBKACPnp60CQQLc3lzOmZsYXZvdXIBdw5hZmZpbmU6c3VyZmFjZScAj56etAkEDHN5czpjaGlsZHJlbgAnAI+enrQJBA1wcm9wOmVsZW1lbnRzASgAj56etAkHBHR5cGUBdxwkYmxvY2tzdWl0ZTppbnRlcm5hbDpuYXRpdmUkJwCPnp60CQcFdmFsdWUBCACPnp60CQIBdwprWi1XOGxlTS00JwCPnp60CQkKS2NiV1B5ZHU5VwEoAI+enrQJCwVpbmRleAF3AmEwKACPnp60CQsEc2VlZAF9jv3T5AwoAI+enrQJCwNmaXQBeCgAj56etAkLBW1hcmtzAXUAKACPnp60CQsDcHB1AX0pKACPnp60CQsGcm90YXRlAX0AKACPnp60CQsCeDABfUEoAI+enrQJCwR4eXdoAXcNWzAsMCw4MjAsNTIwXSgAj56etAkLAnkwAXtAIcGPnBj5wigAj56etAkLBHR5cGUBdwVwbGFuZSgAj56etAkLAmlkAXcKS2NiV1B5ZHU5VwA=';

/** The saved board with one more canvas element. */
function withElement(fields: Record<string, unknown>) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromBase64(SAVED));
  const surface = [...doc.getMap<Y.Map<unknown>>('blocks').values()].find(
    (block) => block.get('sys:flavour') === 'affine:surface'
  );
  const native = surface?.get('prop:elements') as Y.Map<unknown>;
  const elements = native.get('value') as Y.Map<unknown>;
  const element = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(fields)) element.set(key, value);
  elements.set('extra', element);
  return Y.encodeStateAsUpdate(doc);
}

const reason = (update: Uint8Array) => {
  try {
    checkSavedBoard(update);
    return null;
  } catch (error) {
    return error instanceof BoardLoadError ? error.reason : String(error);
  }
};

describe('checkSavedBoard', () => {
  it('opens what the board saved', () => {
    expect(reason(fromBase64(SAVED))).toBeNull();
    expect(
      reason(withElement({ latex: 'x^2', type: 'formula', xywh: '[0,0,9,9]' }))
    ).toBeNull();
  });

  it('refuses what the board never makes or can not draw', () => {
    expect(reason(new Uint8Array([1, 2, 3, 4, 5]))).toBe('unreadable');
    expect(reason(withElement({ type: 'mindmap', xywh: '[0,0,9,9]' }))).toBe(
      'element type mindmap'
    );
    expect(
      reason(withElement({ latex: 7, type: 'formula', xywh: '[0,0,9,9]' }))
    ).toBe('formula latex');
    expect(
      reason(
        withElement({
          axisMax: 10,
          axisStep: 2,
          bars: Array.from({ length: 25 }, () => ({ label: '', value: 1 })),
          kind: 'bar',
          labels: [],
          spokes: [],
          type: 'chart',
          xywh: '[0,0,9,9]',
        })
      )
    ).toBe('chart fields');
  });
});
