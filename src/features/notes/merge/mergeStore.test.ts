import { BaseYjsPlugin } from '@platejs/yjs';
import {
  slateNodesToInsertDelta,
  type YHistoryEditor,
  YjsEditor,
} from '@slate-yjs/core';
import { createPlateEditor } from 'platejs/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  deleted: [] as unknown[],
  fail: false,
  put: [] as { id: string; seq: number }[],
}));
vi.mock('@/lib/editDrafts', async (load) => ({
  ...(await load<typeof import('@/lib/editDrafts')>()),
  deleteDrafts: vi.fn(async (rows: unknown[]) => {
    storage.deleted.push(...rows);
  }),
  putDrafts: vi.fn(async (rows: { id: string; seq: number }[]) => {
    if (storage.fail) throw new Error('quota');
    storage.put.push(...rows.map(({ id, seq }) => ({ id, seq })));
  }),
}));

import * as Y from 'yjs';
import type { MaterialElement } from '@/features/materials/document';
import { stableElementIdsPlugin } from '../stableElementIds';
import { createMergeStore } from './mergeStore';
import { pieceId, pieceKey, pieceRow } from './pieceRows';
import type { MergePiece } from './types';

/* The merge view's per-mount store. */

const KEY = 'u_1:material:m_1';
const p = (id: string, text: string): MaterialElement => ({
  children: [{ text }],
  id,
  type: 'p',
});
const piece = (
  block: string,
  mine: MaterialElement | null,
  source: MergePiece['source'] = 'refused'
): MergePiece => ({
  after: null,
  at: 1,
  block,
  mine,
  source,
});
const LINEAGE = 'material:m_1:schema:1';

function setup(stored: MergePiece[] = []) {
  const ydoc = new Y.Doc();
  ydoc
    .get('content', Y.XmlText)
    .applyDelta(
      slateNodesToInsertDelta([p('a', 'A room'), p('b', 'B')] as never),
      { sanitize: false }
    );
  const editor = createPlateEditor({
    nodeId: false,
    plugins: [
      BaseYjsPlugin.configure({ options: { ydoc } }),
      stableElementIdsPlugin,
    ],
    value: [] as never,
  });
  YjsEditor.connect(editor as never);
  const failed = vi.fn();
  const store = createMergeStore({
    editor,
    key: KEY,
    lineage: LINEAGE,
    onApplyFailed: failed,
    stored: stored.map((each, index) => ({
      piece: each,
      row: pieceRow(KEY, LINEAGE, each, index + 3),
    })),
  });
  const statuses = () =>
    Object.fromEntries(
      store
        .getSnapshot()
        .pieces.map(({ piece: one, status }) => [one.block, status])
    );
  // A piece's key in the store, by its block (one piece each here).
  const keyOf = (block: string) =>
    store.getSnapshot().pieces.find(({ piece: one }) => one.block === block)
      ?.key as string;
  return { editor, failed, keyOf, statuses, store };
}

const frame = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  storage.deleted.length = 0;
  storage.fail = false;
  storage.put.length = 0;
});

describe('the merge store', () => {
  it('lists stored pieces with their status against the note, in document order', () => {
    const { statuses, store } = setup([
      piece('b', p('b', 'B mine')),
      piece('a', p('a', 'A mine')),
    ]);
    expect(
      store.getSnapshot().pieces.map(({ piece: one }) => one.block)
    ).toEqual(['a', 'b']);
    expect(statuses()).toEqual({ a: 'conflict', b: 'conflict' });
    expect(store.getSnapshot().unresolved).toBe(2);
  });

  // Q255: choices that edit the note wait for the live synced note.
  it('applies nothing until the note may be edited', () => {
    const { editor, keyOf, statuses, store } = setup([
      piece('a', p('a', 'A mine')),
    ]);
    store.apply(keyOf('a'), 'apply', editor.children[0] as MaterialElement);
    expect(statuses()).toEqual({ a: 'conflict' });
    store.setCanApply(true);
    store.apply(keyOf('a'), 'apply', editor.children[0] as MaterialElement);
    expect(statuses()).toEqual({ a: 'resolved' });
    expect(store.getSnapshot().unresolved).toBe(0);
  });

  // Q256: an applied piece stays listed; Undo brings it back unresolved.
  it('shows an applied piece unresolved again after Undo, once a frame', async () => {
    const { editor, keyOf, statuses, store } = setup([
      piece('a', p('a', 'A mine')),
    ]);
    store.setCanApply(true);
    store.apply(keyOf('a'), 'apply', editor.children[0] as MaterialElement);
    (editor as unknown as YHistoryEditor).undo();
    store.changed();
    expect(statuses()).toEqual({ a: 'resolved' });
    await frame();
    expect(statuses()).toEqual({ a: 'conflict' });
  });

  it('marks a piece stale when its block changed since shown, applying nothing', () => {
    const { editor, keyOf, statuses, store } = setup([
      piece('a', p('a', 'A mine')),
    ]);
    store.setCanApply(true);
    const shown = editor.children[0] as MaterialElement;
    editor.tf.insertText(' peer', { at: { offset: 6, path: [0, 0] } });
    store.apply(keyOf('a'), 'apply', shown);
    expect(store.getSnapshot().stale).toBe(keyOf('a'));
    expect(statuses()).toEqual({ a: 'conflict' });
  });

  // Merge view review r1 V-M4 (Q409): pieces are kept by block and content.
  // An older refused piece and a newer conflict on one block both stay, each
  // in its own row; a piece equal to a listed one of its block is skipped,
  // so a repeat conversion never duplicates.
  it('keeps an older piece of a block beside a newer different one, and skips an equal one', () => {
    const refused = piece('a', p('a', 'A refused'));
    const { statuses, store } = setup([refused]);
    const conflict = piece('a', p('a', 'A conflict'), 'conflict');
    store.add([conflict, piece('a', p('a', 'A refused'), 'conflict')]);
    expect(storage.put.map(({ id }) => id)).toEqual([pieceId(KEY, conflict)]);
    expect(
      store.getSnapshot().pieces.map(({ key, piece: one }) => [key, one.source])
    ).toEqual([
      [pieceKey(refused), 'refused'],
      [pieceKey(conflict), 'conflict'],
    ]);
    expect(pieceId(KEY, conflict)).not.toBe(pieceId(KEY, refused));
    expect(statuses()).toEqual({ a: 'conflict' });
    expect(store.getSnapshot().unresolved).toBe(2);
    store.add([piece('a', p('a', 'A conflict'))]);
    expect(storage.put).toHaveLength(1);
  });

  // Review r2 N1: two different pieces of one block whose content hashes
  // the same (FNV-1a of these two texts) are both kept, in their own rows.
  it('keeps two different pieces of a block whose hashes collide', () => {
    const first = piece('a', p('a', 't67594'));
    const second = piece('a', p('a', 't830200'));
    expect(pieceKey(first)).toBe(pieceKey(second));
    const { store } = setup();
    store.add([first, second]);
    expect(new Set(storage.put.map(({ id }) => id)).size).toBe(2);
    expect(store.getSnapshot().pieces.map(({ piece: one }) => one)).toEqual([
      first,
      second,
    ]);
  });

  // Review r1 V-L8 (Q410): a rewrite's seq is unique across tabs, not the
  // stored one plus one, so another tab's exact delete of its own rewrite
  // never removes this one.
  it('gives two tabs rewriting the same stored piece different seqs', () => {
    const stored = piece('a', p('a', 'A mine'));
    for (const tab of [setup([stored]), setup([stored])]) {
      tab.store.setCanApply(true);
      tab.store.apply(
        tab.keyOf('a'),
        'insert',
        tab.editor.children[0] as MaterialElement
      );
    }
    const [first, second] = storage.put;
    expect(first.id).toBe(second.id);
    expect(first.seq).not.toBe(second.seq);
  });

  // Q397: the rows pieces came from go only once the pieces are stored;
  // `add` says when (deleteOnceStored waits on it).
  it('resolves an add once its pieces are stored, and rejects when the write fails', async () => {
    const { store } = setup();
    await expect(store.add([piece('a', p('a', 'A mine'))])).resolves.toBe(
      undefined
    );
    storage.fail = true;
    await expect(store.add([piece('b', p('b', 'B mine'))])).rejects.toThrow(
      'quota'
    );
  });

  it('deletes exactly the rows it lets go: a dismissal, Discard, resolved ones on close', () => {
    const { editor, keyOf, store } = setup([
      piece('a', p('a', 'A mine')),
      piece('b', p('b', 'B mine')),
    ]);
    store.setCanApply(true);
    store.apply(keyOf('a'), 'apply', editor.children[0] as MaterialElement);
    store.close();
    expect(storage.deleted).toEqual([
      { id: pieceId(KEY, piece('a', p('a', 'A mine'))), key: KEY, seq: 3 },
    ]);
    store.dismiss(keyOf('b'));
    expect(storage.deleted.at(-1)).toEqual({
      id: pieceId(KEY, piece('b', p('b', 'B mine'))),
      key: KEY,
      seq: 4,
    });
    expect(store.getSnapshot().pieces).toEqual([]);
  });

  // Q261: an apply that throws is an unexpected failure, reported.
  it('reports an apply that throws', () => {
    const { editor, failed, keyOf, store } = setup([
      piece('a', p('a', 'A mine')),
    ]);
    store.setCanApply(true);
    vi.spyOn(editor.tf, 'withoutNormalizing').mockImplementation(() => {
      throw new Error('broken');
    });
    store.apply(keyOf('a'), 'apply', editor.children[0] as MaterialElement);
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'a' }),
      expect.any(Error)
    );
  });
});
