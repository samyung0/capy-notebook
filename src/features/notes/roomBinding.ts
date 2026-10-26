import { YjsEditor } from '@slate-yjs/core';
import {
  createSlatePlugin,
  type Operation,
  OperationApi,
  type TRange,
} from 'platejs';
import type { PlateEditor } from 'platejs/react';
import { blockPoint, pointIn } from './roomSwap';

const synced = new WeakSet<object>();
const waiting = new WeakSet<object>();
const bound = new WeakMap<
  object,
  (unbound: unknown[]) => Promise<unknown> | undefined
>();

/**
 * Binds the note editor to its room's document (`YjsEditor.connect`) only
 * once the room has synced. Plate's init binds after waiting at most 5 s for
 * the sync; bound to a document the room had not filled yet, the editor
 * showed it empty, and Plate gave the empty editor a paragraph the document
 * never got, so after the sync the editor held one block more than the room
 * and every Yjs mapping of a point in it threw. A later sync binds here
 * (`bindSyncedRoom`). Until then the editor holds the note's last projection.
 *
 * Binding replaces the editor's whole tree. What the tree held before (the
 * saved copy, edited when the join failed, Q229) goes to the editor's
 * `whenBound` handler right after, which merges the copy's edits into the
 * room's tree as ordinary edits, once its diff is back from a worker. A
 * selection made before it is then kept by block id where its block and
 * text still exist, as a room swap restores one, else dropped: left on the
 * old paths it pointed into nodes the room's tree lacks; once the merge
 * applied, it is placed again unless the selection moved meanwhile.
 * Goes right after YjsPlugin.
 */
export const roomBindingPlugin = createSlatePlugin({
  extendEditor: ({ editor }) => {
    if (!YjsEditor.isYjsEditor(editor)) return editor;
    const { connect } = editor;
    const plate = editor as unknown as PlateEditor;
    editor.connect = () => {
      if (!synced.has(editor)) {
        waiting.add(editor);
        return;
      }
      waiting.delete(editor);
      const { selection } = editor;
      const kept = selection && {
        anchor: blockPoint(plate, selection.anchor),
        focus: blockPoint(plate, selection.focus),
      };
      const unbound = editor.children;
      editor.selection = null;
      connect();
      const merging = bound.get(editor)?.(unbound);
      const restore = () => {
        const anchor = kept?.anchor && pointIn(plate, kept.anchor);
        const focus = kept?.focus && pointIn(plate, kept.focus);
        if (anchor && focus) plate.tf.select({ anchor, focus });
      };
      restore();
      const placed = editor.selection;
      void merging?.then(() => {
        if (editor.selection === placed) restore();
      });
    };
    // Until the bind, Undo and Redo walk Slate's own history of the saved
    // copy (Q397): the Yjs history works on the bound document only.
    const { redo, undo } = plate;
    const history = (plate as unknown as { history: CopyHistory }).history;
    const walk = (from: Batch[], to: Batch[], back: boolean) => {
      const batch = from.pop();
      if (!batch) return;
      plate.tf.withoutSaving(() =>
        plate.tf.withoutNormalizing(() => {
          if (batch.selectionBefore) plate.tf.select(batch.selectionBefore);
          const ops = back
            ? batch.operations.map(OperationApi.inverse).reverse()
            : batch.operations;
          for (const op of ops) plate.tf.apply(op);
        })
      );
      to.push(batch);
    };
    plate.undo = () =>
      YjsEditor.connected(editor)
        ? undo()
        : walk(history.undos, history.redos, true);
    plate.redo = () =>
      YjsEditor.connected(editor)
        ? redo()
        : walk(history.redos, history.undos, false);
    return editor;
  },
  key: 'capy-room-binding',
});

interface Batch {
  operations: Operation[];
  selectionBefore: TRange | null;
}
interface CopyHistory {
  redos: Batch[];
  undos: Batch[];
}

/** The room synced (the provider's first sync): a bind Plate tried before
 * it happens now. */
export function bindSyncedRoom(editor: object) {
  synced.add(editor);
  if (waiting.has(editor)) YjsEditor.connect(editor as YjsEditor);
}

/** `handler` runs once the editor is bound, with the tree binding replaced
 * (Q229: the copy's edits merge then; the caret is placed again once its
 * promise settles). */
export function whenBound(
  editor: object,
  handler: (unbound: unknown[]) => Promise<unknown> | undefined
) {
  bound.set(editor, handler);
}
