import type { YHistoryEditor } from '@slate-yjs/core';
import { type PlateEditor, useEditorRef } from 'platejs/react';
import { useMemo, useSyncExternalStore } from 'react';
import { ToolbarGroup } from '@/components/ui/Toolbar';
import type { UndoTarget } from '@/features/collaboration/undo';
import { m } from '@/i18n';
import { EditorIcon } from '../EditorIcon';
import { useActiveEmbedUndo } from '../embedUndo';
import { EDITOR_SHORTCUTS, ToolbarButton } from './ToolbarButton';

export function ToolbarHistory() {
  // NoteEditorCore installs YjsPlugin before rendering the toolbar.
  const editor = useEditorRef() as PlateEditor & YHistoryEditor;
  const manager = editor.undoManager;
  const note = useMemo<UndoTarget>(
    () => ({
      canRedo: () => manager.redoStack.length > 0,
      canUndo: () => manager.undoStack.length > 0,
      redo: () => editor.redo(),
      subscribe: (notify) => {
        manager.on('stack-item-added', notify);
        manager.on('stack-item-popped', notify);
        manager.on('stack-cleared', notify);
        return () => {
          manager.off('stack-item-added', notify);
          manager.off('stack-item-popped', notify);
          manager.off('stack-cleared', notify);
        };
      },
      undo: () => editor.undo(),
    }),
    [editor, manager]
  );
  // The embed last pressed lends its quiz's or set's history (embedUndo).
  const target = useActiveEmbedUndo() ?? note;
  const canUndo = useSyncExternalStore(target.subscribe, target.canUndo);
  const canRedo = useSyncExternalStore(target.subscribe, target.canRedo);

  // Phones go without them everywhere (Epo 2026-11-04); shortcuts stay.
  return (
    <ToolbarGroup className="hidden sm:flex">
      <ToolbarButton
        disabled={!canUndo}
        label={m.editor_undo()}
        onClick={() => target.undo()}
        shortcut={EDITOR_SHORTCUTS.undo}
      >
        <EditorIcon name="undo" />
      </ToolbarButton>
      <ToolbarButton
        disabled={!canRedo}
        label={m.editor_redo()}
        onClick={() => target.redo()}
        shortcut={EDITOR_SHORTCUTS.redo}
      >
        <EditorIcon name="redo" />
      </ToolbarButton>
    </ToolbarGroup>
  );
}
