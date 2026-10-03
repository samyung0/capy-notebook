import { createContext, useContext, useEffect } from 'react';
import type {
  NoteEditorSaveState,
  NoteEditorStatus,
} from '@/features/notes/editorMode';

export type FileMode = 'view' | 'edit';

// Keep context identity separate from the hot-reloaded file controls.
export const FileHeaderTarget = createContext<HTMLElement | null>(null);

/** An Office file header's menu bar row and its action buttons (Present). */
export const FileMenuTarget = createContext<HTMLElement | null>(null);
export const FileActionsTarget = createContext<HTMLElement | null>(null);

export const FileModeContext = createContext<{
  mode: FileMode;
  onChange: (mode: FileMode) => void;
} | null>(null);

/** The header's save status slot, shared by notes and editable files. */
export const EditorStatusContext = createContext<
  ((status: NoteEditorStatus | null) => void) | null
>(null);

/** Shows a file editor's save state in the header, as the note editor does. */
export function useReportEditorStatus(saveState: NoteEditorSaveState | null) {
  const report = useContext(EditorStatusContext);
  useEffect(() => {
    report?.(saveState ? { saveState } : null);
  }, [report, saveState]);
  useEffect(() => () => report?.(null), [report]);
}
