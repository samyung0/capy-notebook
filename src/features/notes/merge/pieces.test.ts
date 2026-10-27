import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type {
  MaterialElement,
  MaterialValue,
} from '@/features/materials/document';
import { changedBlocks, pieceStatus, piecesFromDrafts } from './pieces';
import type { MergePiece } from './types';

/* The merge view (Q251): a stored Yjs group becomes pieces, the blocks
 * in which the user's document shows something the room's does not. */

const p = (id: string, text: string, extra = {}): MaterialElement => ({
  children: [{ text }],
  id,
  type: 'p',
  ...extra,
});

/** A room and a tab that synced with it, then went apart. */
function apart(value: MaterialValue) {
  const room = new Y.Doc();
  room
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(value as never), { sanitize: false });
  const tab = new Y.Doc();
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(room));
  return { room, tab };
}

const blockOf = (doc: Y.Doc, id: string) =>
  (doc.get('content', Y.XmlText).toDelta() as { insert: Y.XmlText }[])
    .map(({ insert }) => insert)
    .find((block) => block.getAttribute('id') === id) as Y.XmlText;
const indexOf = (doc: Y.Doc, id: string) =>
  (
    doc.get('content', Y.XmlText).toDelta() as { insert: Y.XmlText }[]
  ).findIndex(({ insert }) => insert.getAttribute('id') === id);
const blocksOf = (doc: Y.Doc) =>
  yTextToSlateElement(doc.get('content', Y.XmlText))
    .children as unknown as MaterialValue;
const pieces = (tab: Y.Doc, room: Y.Doc) =>
  piecesFromDrafts(tab, room, blocksOf(room), 'refused', 1).map(
    ({ block, mine, after }) => ({ after, block, mine })
  );

describe('piecesFromDrafts', () => {
  it('makes a piece of typing into an existing block', () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B')]);
    blockOf(tab, 'b').insert(1, ' typed');
    expect(pieces(tab, room)).toEqual([
      { after: 'a', block: 'b', mine: p('b', 'B typed') },
    ]);
  });

  it('makes a piece of a block the user deleted that the room still shows', () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B')]);
    tab.get('content', Y.XmlText).delete(indexOf(tab, 'b'), 1);
    expect(pieces(tab, room)).toEqual([
      { after: null, block: 'b', mine: null },
    ]);
  });

  it('makes a piece of an attribute change', () => {
    const { room, tab } = apart([p('a', 'A')]);
    blockOf(tab, 'a').setAttribute('indent', 1 as never);
    expect(pieces(tab, room)).toEqual([
      { after: null, block: 'a', mine: p('a', 'A', { indent: 1 }) },
    ]);
  });

  it('makes a piece of a new block, after the block before it', () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B')]);
    tab
      .get('content', Y.XmlText)
      .applyDelta(
        [{ retain: 1 }, ...slateNodesToInsertDelta([p('n', 'N')] as never)],
        {
          sanitize: false,
        }
      );
    expect(pieces(tab, room)).toEqual([
      { after: 'a', block: 'n', mine: p('n', 'N') },
    ]);
  });

  it('makes a piece of typing in a block the room deleted', () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B')]);
    blockOf(tab, 'b').insert(1, ' typed');
    room.get('content', Y.XmlText).delete(indexOf(room, 'b'), 1);
    expect(pieces(tab, room)).toEqual([
      { after: 'a', block: 'b', mine: p('b', 'B typed') },
    ]);
  });

  it('counts a change nested in a column group as that top-level block', () => {
    const group: MaterialElement = {
      children: [
        { children: [p('x', 'left')], id: 'c1', type: 'column' },
        { children: [p('y', 'right')], id: 'c2', type: 'column' },
      ],
      id: 'g',
      type: 'column_group',
    };
    const { room, tab } = apart([p('a', 'A'), group]);
    const left = (
      blockOf(tab, 'g').toDelta()[0].insert as Y.XmlText
    ).toDelta()[0].insert as Y.XmlText;
    left.insert(4, ' typed');
    const [piece] = pieces(tab, room);
    expect(piece.block).toBe('g');
    expect(JSON.stringify(piece.mine)).toContain('left typed');
  });

  it("makes no piece of the room's own changes, nor of a block equal to the current one", () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B')]);
    blockOf(room, 'a').insert(1, ' room');
    expect(pieces(tab, room)).toEqual([]);
    // The same text typed on both sides: equal content, no piece.
    blockOf(tab, 'b').insert(1, ' same');
    blockOf(room, 'b').insert(1, ' same');
    expect(pieces(tab, room)).toEqual([]);
  });

  // A move is a delete and a new copy of the block under its id: the block
  // is the user's to review, but its content equals the current one, so no
  // piece (pieces compare content; a place is not content).
  it('marks a moved block changed and makes no piece of its equal content', () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B'), p('c', 'C')]);
    const root = tab.get('content', Y.XmlText);
    tab.transact(() => {
      root.delete(indexOf(tab, 'a'), 1);
      root.applyDelta(
        [{ retain: 2 }, ...slateNodesToInsertDelta([p('a', 'A')] as never)],
        { sanitize: false }
      );
    });
    const since = Y.decodeStateVector(Y.encodeStateVector(room));
    expect([...changedBlocks(tab, room, since)]).toEqual(['a']);
    expect(pieces(tab, room)).toEqual([]);
  });

  // The late path's `since` is the room's vector before the merged update:
  // edits the room placed since are shown there, so they are not the
  // user's to review; ones it dropped are.
  it('takes edits past an older `since` that the room shows as placed', () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B')]);
    const since = Y.decodeStateVector(Y.encodeStateVector(room));
    blockOf(tab, 'a').insert(1, ' placed');
    Y.applyUpdate(room, Y.encodeStateAsUpdate(tab, Y.encodeStateVector(room)));
    blockOf(tab, 'b').insert(1, ' dropped');
    expect([...changedBlocks(tab, room, since)]).toEqual(['b']);
  });

  it('makes no piece for a block without an id', () => {
    const { room, tab } = apart([
      { children: [{ text: 'loose' }], type: 'p' },
    ] as MaterialValue);
    (tab.get('content', Y.XmlText).toDelta()[0].insert as Y.XmlText).insert(
      5,
      ' typed'
    );
    expect(pieces(tab, room)).toEqual([]);
  });
});

describe('pieceStatus', () => {
  const piece = (
    mine: MaterialElement | null,
    extra: Partial<MergePiece> = {}
  ) =>
    ({
      after: null,
      at: 1,
      block: 'a',
      mine,
      source: 'refused',
      ...extra,
    }) as MergePiece;
  const note = (blocks: MaterialElement[]) => (id: string) =>
    blocks.find((block) => block.id === id);

  it('reads conflict, deleted on either side and resolved from the note now', () => {
    expect(pieceStatus(piece(p('a', 'Mine')), note([p('a', 'Room')]))).toBe(
      'conflict'
    );
    expect(pieceStatus(piece(p('a', 'Mine')), note([]))).toBe('theirs-deleted');
    expect(pieceStatus(piece(null), note([p('a', 'Room')]))).toBe(
      'mine-deleted'
    );
    expect(pieceStatus(piece(null), note([]))).toBe('resolved');
    expect(pieceStatus(piece(p('a', 'Mine')), note([p('a', 'Mine')]))).toBe(
      'resolved'
    );
    // Inserted as a new block: resolved while that block is in the note.
    expect(
      pieceStatus(
        piece(p('a', 'Mine'), { insertedAs: 'n' }),
        note([p('a', 'Room'), p('n', 'Mine')])
      )
    ).toBe('resolved');
    expect(
      pieceStatus(
        piece(p('a', 'Mine'), { insertedAs: 'n' }),
        note([p('a', 'Room')])
      )
    ).toBe('conflict');
  });
});
