import type { YHistoryEditor } from '@slate-yjs/core';
import { type PlateEditor, useEditorRef } from 'platejs/react';
import { useCallback, useSyncExternalStore } from 'react';
import { ToolbarGroup } from '@/components/ui/Toolbar';
import { m } from '@/i18n';
import { EditorIcon } from '../EditorIcon';
import { EDITOR_SHORTCUTS, ToolbarButton } from './ToolbarButton';

export function ToolbarHistory() {
  // NoteEditorCore installs YjsPlugin before rendering the toolbar.
  const editor = useEditorRef() as PlateEditor & YHistoryEditor;
  const manager = editor.undoManager;
  const subscribe = useCallback(
    (notify: () => void) => {
      manager.on('stack-item-added', notify);
      manager.on('stack-item-popped', notify);
      manager.on('stack-cleared', notify);
      return () => {
        manager.off('stack-item-added', notify);
        manager.off('stack-item-popped', notify);
        manager.off('stack-cleared', notify);
      };
    },
    [manager]
  );
  const canUndo = useSyncExternalStore(
    subscribe,
    () => manager.undoStack.length > 0
  );
  const canRedo = useSyncExternalStore(
    subscribe,
    () => manager.redoStack.length > 0
  );

  return (
    <ToolbarGroup>
      <ToolbarButton
        disabled={!canUndo}
        label={m.editor_undo()}
        onClick={() => editor.undo()}
        shortcut={EDITOR_SHORTCUTS.undo}
      >
        <EditorIcon name="undo" />
      </ToolbarButton>
      <ToolbarButton
        disabled={!canRedo}
        label={m.editor_redo()}
        onClick={() => editor.redo()}
        shortcut={EDITOR_SHORTCUTS.redo}
      >
        <EditorIcon name="redo" />
      </ToolbarButton>
    </ToolbarGroup>
  );
}
