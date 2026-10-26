import { slateNodesToInsertDelta } from '@slate-yjs/core';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type {
  MaterialElement,
  MaterialValue,
} from '@/features/materials/document';
import { draftClients, watchHiddenTyping } from './hiddenTyping';
import { pieceKey } from './pieceRows';

/* Hidden typing at a join (Q237, Q258): the server's step 1 arms the watch,
 * its step 2 may delete a block holding typing it never saw. */

const ROOM = Symbol('room');
const p = (id: string, text: string): MaterialElement => ({
  children: [{ text }],
  id,
  type: 'p',
});

const rootOf = (doc: Y.Doc) => doc.get('content', Y.XmlText);
const blocks = (doc: Y.Doc) =>
  (rootOf(doc).toDelta() as { insert: Y.XmlText }[]).map(
    ({ insert }) => insert
  );
const blockOf = (doc: Y.Doc, id: string) =>
  blocks(doc).find((block) => block.getAttribute('id') === id) as Y.XmlText;
const remove = (doc: Y.Doc, id: string) =>
  rootOf(doc).delete(
    blocks(doc).findIndex((block) => block.getAttribute('id') === id),
    1
  );
const child = (type: Y.XmlText, index: number) =>
  (type.toDelta() as { insert: Y.XmlText }[])[index].insert;
const row = (id: string, cell: string, text: string) => ({
  children: [{ children: [p(cell, text)], id: `${id}d`, type: 'td' }],
  id,
  type: 'tr',
});
const TABLE = {
  children: [row('r1', 'x', 'one'), row('r2', 'y', 'two')],
  id: 't',
  type: 'table',
} as MaterialElement;
/** The paragraph in a table's row `index`. */
const cellText = (doc: Y.Doc, index: number) =>
  child(child(child(blockOf(doc, 't'), index), 0), 0);

/** A tab's typing as stored update rows without a state row: a fresh
 * document holds it pending until the sync brings its base. */
function restoredOnly(tab: Y.Doc, type: () => void) {
  const updates: Uint8Array[] = [];
  tab.on('update', (update: Uint8Array) => updates.push(update));
  type();
  const data = Y.mergeUpdates(updates);
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, data);
  return { fresh, rows: [{ data, kind: 'update' }] };
}

/** A room and a tab that synced with it, then went apart; the room keeps
 * deleted content when `gc` is false. */
function apart(value: MaterialValue, gc = true) {
  const room = new Y.Doc({ gc });
  rootOf(room).applyDelta(slateNodesToInsertDelta(value as never), {
    sanitize: false,
  });
  const tab = new Y.Doc();
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(room));
  return { room, tab };
}

/** The join as the server runs it: its step 1 (its vector), then its step 2
 * (what the tab lacks), applied with the room's origin. `drafted`: the
 * clients of the tab's stored rows. */
function join(
  tab: Y.Doc,
  room: Y.Doc,
  drafted: () => ReadonlySet<number> = () => new Set([tab.clientID])
) {
  const watch = watchHiddenTyping(tab, (origin) => origin === ROOM, drafted);
  return {
    step1: () => watch.armed(Y.encodeStateVector(room)),
    step2: () => {
      Y.applyUpdate(
        tab,
        Y.encodeStateAsUpdate(room, Y.encodeStateVector(tab)),
        ROOM
      );
      return watch.synced(1);
    },
  };
}

describe('watchHiddenTyping', () => {
  it('makes a piece of offline typing in a block someone deleted, with the typed text', () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B')]);
    blockOf(tab, 'b').insert(1, ' typed');
    remove(room, 'b');
    const { step1, step2 } = join(tab, room);
    step1();
    expect(step2()).toEqual([
      {
        after: 'a',
        at: 1,
        block: 'b',
        mine: p('b', 'B typed'),
        source: 'hidden',
      },
    ]);
  });

  it('reports nothing of text the room had seen and then deleted', () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B')]);
    blockOf(tab, 'a').insert(1, ' seen');
    Y.applyUpdate(room, Y.encodeStateAsUpdate(tab));
    // Unsent typing elsewhere keeps the watch armed.
    blockOf(tab, 'b').insert(1, ' unsent');
    remove(room, 'a');
    const { step1, step2 } = join(tab, room);
    step1();
    expect(step2()).toEqual([]);
  });

  it('counts typing between the step 1 and the step 2', () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B')]);
    blockOf(tab, 'a').insert(1, ' unsent');
    remove(room, 'b');
    const { step1, step2 } = join(tab, room);
    step1();
    blockOf(tab, 'b').insert(1, ' meanwhile');
    expect(step2().map(({ block, mine }) => ({ block, mine }))).toEqual([
      { block: 'b', mine: p('b', 'B meanwhile') },
    ]);
  });

  it('never reports a new top-level block', () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B')]);
    rootOf(tab).applyDelta([
      { retain: 2 },
      ...slateNodesToInsertDelta([p('n', 'New')] as never),
    ]);
    remove(room, 'b');
    const { step1, step2 } = join(tab, room);
    step1();
    expect(step2()).toEqual([]);
  });

  it("makes a piece of a table whose deleted row held typing, the table's own block", () => {
    const { room, tab } = apart([p('a', 'A'), TABLE]);
    cellText(tab, 1).insert(3, ' typed');
    blockOf(room, 't').delete(1, 1);
    const { step1, step2 } = join(tab, room);
    step1();
    const [piece, ...rest] = step2();
    expect(rest).toEqual([]);
    expect(piece.block).toBe('t');
    expect(JSON.stringify(piece.mine)).toContain('two typed');
    // The room still holds the table: the current block is present.
    expect(blockOf(tab, 't')).toBeDefined();
  });

  it('keeps the text of restored rows that integrate into a deleted block as a plain piece', () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B')], false);
    const { fresh, rows } = restoredOnly(tab, () =>
      blockOf(tab, 'b').insert(1, ' lost')
    );
    expect(fresh.store.pendingStructs).not.toBeNull();
    remove(room, 'b');
    const { step1, step2 } = join(fresh, room, () => draftClients(rows));
    step1();
    expect(step2()).toEqual([
      {
        after: 'a',
        at: 1,
        block: 'b',
        mine: p('b', ' lost'),
        plain: true,
        source: 'hidden',
      },
    ]);
  });

  // Merge view review r1 V-M4 (Q409): typing in two cells of a deleted
  // table is two plain pieces of one block, each with its own key, so the
  // store keeps both.
  it('keeps the text of two parents in one deleted block as two pieces', () => {
    const { room, tab } = apart([p('a', 'A'), TABLE], false);
    const { fresh, rows } = restoredOnly(tab, () => {
      cellText(tab, 0).insert(3, ' first');
      cellText(tab, 1).insert(3, ' second');
    });
    remove(room, 't');
    const { step1, step2 } = join(fresh, room, () => draftClients(rows));
    step1();
    const pieces = step2();
    expect(pieces.map(({ block, mine }) => [block, mine])).toEqual([
      ['t', p('t', ' first')],
      ['t', p('t', ' second')],
    ]);
    expect(pieceKey(pieces[0])).not.toBe(pieceKey(pieces[1]));
  });

  // Review r1 V-L9 (Q410): text another client typed and deleted within
  // one update the room forwards is not the user's, so it is no plain piece.
  it("makes no plain piece of a peer's text typed and deleted in one update", () => {
    const { room, tab } = apart([p('a', 'A'), p('b', 'B')], false);
    const peer = new Y.Doc({ gc: false });
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(room));
    // Unsent typing of the tab's own keeps the watch armed.
    blockOf(tab, 'a').insert(1, ' unsent');
    const { step1, step2 } = join(tab, room);
    step1();
    // After the room's step 1, a peer's update it forwards with the sync.
    peer.transact(() => {
      blockOf(peer, 'b').insert(1, ' peer');
      blockOf(peer, 'b').delete(1, 5);
    });
    Y.applyUpdate(room, Y.encodeStateAsUpdate(peer));
    expect(step2()).toEqual([]);
  });

  it('stays idle with nothing unsent', () => {
    const { room, tab } = apart([p('a', 'A')]);
    const on = vi.spyOn(tab, 'on');
    const drafted = vi.fn(() => new Set<number>());
    const watch = watchHiddenTyping(tab, (origin) => origin === ROOM, drafted);
    watch.armed(Y.encodeStateVector(room));
    expect(on).not.toHaveBeenCalled();
    expect(watch.synced()).toEqual([]);
    expect(drafted).not.toHaveBeenCalled();
  });
});
