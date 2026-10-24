import { YjsEditor } from '@slate-yjs/core';
import { createSlatePlugin } from 'platejs';
import type { PlateEditor } from 'platejs/react';
import { blockPoint, pointIn } from './roomSwap';

const synced = new WeakSet<object>();
const waiting = new WeakSet<object>();

/**
 * Binds the note editor to its room's document (`YjsEditor.connect`) only
 * once the room has synced. Plate's init binds after waiting at most 5 s for
 * the sync; bound to a document the room had not filled yet, the editor
 * showed it empty, and Plate gave the empty editor a paragraph the document
 * never got, so after the sync the editor held one block more than the room
 * and every Yjs mapping of a point in it threw. A later sync binds here
 * (`bindSyncedRoom`). Until then the editor holds the note's last projection.
 *
 * Binding replaces the editor's whole tree. A selection made before it (on
 * the projection, painted when the join failed) is kept by block id where
 * its block and text still exist, as a room swap restores one, else dropped:
 * left on the old paths it pointed into nodes the room's tree lacks.
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
      editor.selection = null;
      connect();
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
