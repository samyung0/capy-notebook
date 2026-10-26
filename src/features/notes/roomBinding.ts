import { YjsEditor } from '@slate-yjs/core';
import { createSlatePlugin } from 'platejs';
import type { PlateEditor } from 'platejs/react';
import { blockPoint, pointIn } from './roomSwap';

const synced = new WeakSet<object>();
const waiting = new WeakSet<object>();
const bound = new WeakMap<object, (unbound: unknown[]) => void>();

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
 * room's tree as ordinary edits. A selection made before it is then kept by
 * block id where its block and text still exist, as a room swap restores
 * one, else dropped: left on the old paths it pointed into nodes the room's
 * tree lacks. Goes right after YjsPlugin.
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
      bound.get(editor)?.(unbound);
      const anchor = kept?.anchor && pointIn(plate, kept.anchor);
      const focus = kept?.focus && pointIn(plate, kept.focus);
      if (anchor && focus) plate.tf.select({ anchor, focus });
    };
    return editor;
  },
  key: 'capy-room-binding',
});

/** The room synced (the provider's first sync): a bind Plate tried before
 * it happens now. */
export function bindSyncedRoom(editor: object) {
  synced.add(editor);
  if (waiting.has(editor)) YjsEditor.connect(editor as YjsEditor);
}

/** `handler` runs once the editor is bound, with the tree binding replaced
 * (Q229: the copy's edits merge then). */
export function whenBound(
  editor: object,
  handler: (unbound: unknown[]) => void
) {
  bound.set(editor, handler);
}
