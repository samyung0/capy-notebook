import { createContext, useContext, useEffect } from 'react';
import type { PresenceConnection } from '@/features/collaboration/presence';
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
/** The Office runtime's menus are in the header, so its file is visible: the
 * header shows its second row from then on (Epo 2026-10-20). */
export const FileMenuShown = createContext<((shown: boolean) => void) | null>(
  null
);

export const FileModeContext = createContext<{
  mode: FileMode;
  onChange: (mode: FileMode) => void;
} | null>(null);

/** The header's save status slot, shared by notes and editable files. */
export const EditorStatusContext = createContext<
  ((status: NoteEditorStatus | null) => void) | null
>(null);

/** The header's room presence slot (`presence.ts`) for editable files;
 * notes and items report through their props. */
export const PresenceContext = createContext<
  ((connections: PresenceConnection[] | null) => void) | null
>(null);

/** Shows a file editor's save state in the header, as the note editor does;
 * a slowed open says so beside it, on the top row (Epo 2026-10-20). */
export function useReportEditorStatus(
  saveState: NoteEditorSaveState | null,
  slowed = false
) {
  const report = useContext(EditorStatusContext);
  useEffect(() => {
    report?.(
      saveState ? (slowed ? { saveState, slowed } : { saveState }) : null
    );
  }, [report, saveState, slowed]);
  useEffect(() => () => report?.(null), [report]);
}
