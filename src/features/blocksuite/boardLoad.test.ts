import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { fromBase64 } from './base64';
import { SAVED, withElement } from './boardFixture';
import { BoardLoadError, checkSavedBoard } from './boardLoad';

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

  it('refuses a block out of place', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, fromBase64(SAVED));
    const blocks = doc.getMap<Y.Map<unknown>>('blocks');
    const page = [...blocks.values()].find(
      (block) => block.get('sys:flavour') === 'affine:page'
    );
    // A paragraph straight under the page, with no note.
    const paragraph = new Y.Map<unknown>();
    paragraph.set('sys:id', 'loose');
    paragraph.set('sys:flavour', 'affine:paragraph');
    paragraph.set('sys:children', new Y.Array());
    blocks.set('loose', paragraph);
    const children = page?.get('sys:children') as Y.Array<string>;
    children.push(['loose']);
    expect(reason(Y.encodeStateAsUpdate(doc))).toBe('block tree');
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
