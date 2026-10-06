import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyChildren,
  childWrites,
  keptIds,
  planChildren,
} from './children.js';

const paragraph = (text: string) => ({
  children: [{ text }],
  id: `p-${text}`,
  type: 'p',
});
const quizBlock = (id: string, materialId: string) => ({
  children: [{ text: '' }],
  id,
  materialId,
  refKind: 'quiz',
  type: 'material_ref',
});
const image = (id: string, assetId: string) => ({
  assetId,
  children: [{ text: '' }],
  id,
  type: 'img',
});

/** A note holding `before`, then the update that inserts `inserted` after it,
 * applied the way a client's update reaches the room. */
function noteWithUpdate(before: unknown[], inserted: unknown[]) {
  const document = new Y.Doc();
  const root = document.get('content', Y.XmlText);
  root.applyDelta(slateNodesToInsertDelta(before as never));
  const state = Y.encodeStateVector(document);
  root.applyDelta([
    { retain: before.length },
    ...slateNodesToInsertDelta(inserted as never),
  ]);
  return { document, update: Y.encodeStateAsUpdate(document, state) };
}

const value = (document: Y.Doc) =>
  (
    yTextToSlateElement(document.get('content', Y.XmlText)) as {
      children: unknown[];
    }
  ).children;

describe('children pass', () => {
  it('reads the child ids an update wrote, not typing', () => {
    const { document, update } = noteWithUpdate(
      [paragraph('intro'), quizBlock('b1', 'mat_own')],
      [quizBlock('b2', 'mat_other'), image('i1', 'asset_other')]
    );
    const writes = childWrites(document, update);
    expect(writes?.assetIds).toEqual(['asset_other']);
    expect(
      [...(writes?.blocks ?? [])].map((block) => block.getAttribute('id'))
    ).toEqual(['b2']);

    const typing = noteWithUpdate([paragraph('intro')], [paragraph('more')]);
    expect(childWrites(typing.document, typing.update)).toBeNull();

    // An overwrite carries no key in the update itself: the document has it.
    const block = [...(writes?.blocks ?? [])][0];
    const state = Y.encodeStateVector(document);
    block.setAttribute('materialId', 'mat_next');
    const overwrite = childWrites(
      document,
      Y.encodeStateAsUpdate(document, state)
    );
    expect([...(overwrite?.blocks ?? [])]).toEqual([block]);
  });

  it('keeps a quiz with its first block and asks for copies for the others', () => {
    // b1 was there; the paste brings b2 (the same quiz) and b3 (another
    // note's quiz, twice).
    const { document, update } = noteWithUpdate(
      [quizBlock('b1', 'mat_own')],
      [
        quizBlock('b2', 'mat_own'),
        quizBlock('b3', 'mat_other'),
        quizBlock('b4', 'mat_other'),
      ]
    );
    const writes = childWrites(document, update);
    if (!writes) throw new Error('no writes');
    expect(planChildren(document, writes).blocks).toEqual([
      { blockId: 'b2', copy: true, materialId: 'mat_own' },
      { blockId: 'b3', copy: false, materialId: 'mat_other' },
      { blockId: 'b4', copy: true, materialId: 'mat_other' },
    ]);
  });

  it('repoints to the own children and drops what cannot stay', () => {
    const { document, update } = noteWithUpdate(
      [paragraph('intro')],
      [
        quizBlock('b1', 'mat_other'),
        quizBlock('b2', 'mat_purged'),
        image('i1', 'asset_other'),
        image('i2', 'asset_own'),
        image('i3', 'asset_gone'),
      ]
    );
    const writes = childWrites(document, update);
    if (!writes) throw new Error('no writes');
    const plan = planChildren(document, writes);
    const answer = {
      assets: new Map([
        ['asset_other', 'asset_copy'],
        ['asset_own', 'asset_own'],
        ['asset_gone', ''],
      ]),
      blocks: new Map([
        ['b1', 'mat_copy'],
        ['b2', ''],
      ]),
    };
    expect(applyChildren(document, answer)).toBe(true);
    expect(value(document)).toEqual([
      paragraph('intro'),
      quizBlock('b1', 'mat_copy'),
      image('i1', 'asset_copy'),
      image('i2', 'asset_own'),
    ]);
    expect(keptIds(plan, answer)).toEqual({
      assetIds: ['asset_own'],
      materialIds: [],
    });
    // Answered again (nothing moved): no change.
    expect(applyChildren(document, answer)).toBe(false);
  });
});
