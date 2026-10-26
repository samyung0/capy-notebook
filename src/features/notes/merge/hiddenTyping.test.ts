import { slateNodesToInsertDelta } from '@slate-yjs/core';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type {
  MaterialElement,
  MaterialValue,
} from '@/features/materials/document';
import { watchHiddenTyping } from './hiddenTyping';

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
 * (what the tab lacks), applied with the room's origin. */
function join(tab: Y.Doc, room: Y.Doc) {
  const watch = watchHiddenTyping(tab, (origin) => origin === ROOM);
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
    const cell = (row: string, id: string, text: string) => ({
      children: [{ children: [p(id, text)], id: `${row}d`, type: 'td' }],
      id: row,
      type: 'tr',
    });
    const table = {
      children: [cell('r1', 'x', 'one'), cell('r2', 'y', 'two')],
      id: 't',
      type: 'table',
    } as MaterialElement;
    const { room, tab } = apart([p('a', 'A'), table]);
    child(child(child(blockOf(tab, 't'), 1), 0), 0).insert(3, ' typed');
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
    const updates: Uint8Array[] = [];
    tab.on('update', (update: Uint8Array) => updates.push(update));
    blockOf(tab, 'b').insert(1, ' lost');
    // Rows without a state row: pending on a fresh document until the sync.
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.mergeUpdates(updates));
    expect(fresh.store.pendingStructs).not.toBeNull();
    remove(room, 'b');
    const { step1, step2 } = join(fresh, room);
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

  it('stays idle with nothing unsent', () => {
    const { room, tab } = apart([p('a', 'A')]);
    const on = vi.spyOn(tab, 'on');
    const watch = watchHiddenTyping(tab, (origin) => origin === ROOM);
    watch.armed(Y.encodeStateVector(room));
    expect(on).not.toHaveBeenCalled();
    expect(watch.synced()).toEqual([]);
  });
});
