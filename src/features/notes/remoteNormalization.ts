import { YjsEditor } from '@slate-yjs/core';
import { createSlatePlugin } from 'platejs';

/**
 * Send a remote change's normalization at once. Slate-Yjs applies a remote
 * Yjs event without normalizing; the normalization that follows (merging the
 * leaves a remote insert left side by side, say) runs as local operations,
 * which Slate-Yjs keeps with the tree they were made on and flushes at the
 * next onChange (a microtask) or at the start of the next remote event. A
 * second remote update in the same task (two Yjs transactions before that
 * microtask; the in-page mock room can do it, the server's frames cannot)
 * would flush them onto the newer Yjs state, writing the wrong change into
 * the shared document. Flushed right after their event, they meet the state they were
 * made on. Goes after YjsPlugin, which makes the editor a Yjs editor.
 */
export const remoteNormalizationPlugin = createSlatePlugin({
  extendEditor: ({ editor }) => {
    if (!YjsEditor.isYjsEditor(editor)) return editor;
    const { applyRemoteEvents } = editor;
    editor.applyRemoteEvents = (events, origin) => {
      applyRemoteEvents(events, origin);
      YjsEditor.flushLocalChanges(editor);
    };
    return editor;
  },
  key: 'capy-remote-normalization',
});
