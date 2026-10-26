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
import { pieceId } from './pieceRows';
import type { MergePiece } from './types';

/* The merge view's per-mount store. */

const KEY = 'u_1:material:m_1';
const p = (id: string, text: string): MaterialElement => ({
  children: [{ text }],
  id,
  type: 'p',
});
const piece = (block: string, mine: MaterialElement | null): MergePiece => ({
  after: null,
  at: 1,
  block,
  mine,
  source: 'refused',
});

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
    lineage: 'material:m_1:schema:1',
    onApplyFailed: failed,
    stored: stored.map((each, index) => ({
      piece: each,
      row: { seq: index + 3 } as never,
    })),
  });
  const statuses = () =>
    Object.fromEntries(
      store
        .getSnapshot()
        .pieces.map(({ piece: one, status }) => [one.block, status])
    );
  return { editor, failed, statuses, store };
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
    const { editor, statuses, store } = setup([piece('a', p('a', 'A mine'))]);
    store.apply('a', 'apply', editor.children[0] as MaterialElement);
    expect(statuses()).toEqual({ a: 'conflict' });
    store.setCanApply(true);
    store.apply('a', 'apply', editor.children[0] as MaterialElement);
    expect(statuses()).toEqual({ a: 'resolved' });
    expect(store.getSnapshot().unresolved).toBe(0);
  });

  // Q256: an applied piece stays listed; Undo brings it back unresolved.
  it('shows an applied piece unresolved again after Undo, once a frame', async () => {
    const { editor, statuses, store } = setup([piece('a', p('a', 'A mine'))]);
    store.setCanApply(true);
    store.apply('a', 'apply', editor.children[0] as MaterialElement);
    (editor as unknown as YHistoryEditor).undo();
    store.changed();
    expect(statuses()).toEqual({ a: 'resolved' });
    await frame();
    expect(statuses()).toEqual({ a: 'conflict' });
  });

  it('marks a piece stale when its block changed since shown, applying nothing', () => {
    const { editor, statuses, store } = setup([piece('a', p('a', 'A mine'))]);
    store.setCanApply(true);
    const shown = editor.children[0] as MaterialElement;
    editor.tf.insertText(' peer', { at: { offset: 6, path: [0, 0] } });
    store.apply('a', 'apply', shown);
    expect(store.getSnapshot().stale).toBe('a');
    expect(statuses()).toEqual({ a: 'conflict' });
  });

  // One row per block per document: a second piece for a block replaces the
  // first under the same id with a higher seq, so a repeat conversion never
  // duplicates. Fails with a random id.
  it('keeps one row per block, the newer replacing the older', () => {
    const { store } = setup([piece('a', p('a', 'A mine'))]);
    store.add([piece('a', p('a', 'A newer')), piece('b', p('b', 'B mine'))]);
    expect(storage.put).toEqual([
      { id: pieceId(KEY, 'a'), seq: 4 },
      { id: pieceId(KEY, 'b'), seq: 1 },
    ]);
    expect(store.getSnapshot().pieces).toHaveLength(2);
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
    const { editor, store } = setup([
      piece('a', p('a', 'A mine')),
      piece('b', p('b', 'B mine')),
    ]);
    store.setCanApply(true);
    store.apply('a', 'apply', editor.children[0] as MaterialElement);
    store.close();
    expect(storage.deleted).toEqual([
      { id: pieceId(KEY, 'a'), key: KEY, seq: 3 },
    ]);
    store.dismiss('b');
    expect(storage.deleted.at(-1)).toEqual({
      id: pieceId(KEY, 'b'),
      key: KEY,
      seq: 4,
    });
    expect(store.getSnapshot().pieces).toEqual([]);
  });

  // Q261: an apply that throws is an unexpected failure, reported.
  it('reports an apply that throws', () => {
    const { editor, failed, store } = setup([piece('a', p('a', 'A mine'))]);
    store.setCanApply(true);
    vi.spyOn(editor.tf, 'withoutNormalizing').mockImplementation(() => {
      throw new Error('broken');
    });
    store.apply('a', 'apply', editor.children[0] as MaterialElement);
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'a' }),
      expect.any(Error)
    );
  });
});
