import { m } from '@/i18n';

/** The header save/connection status of every editable file: notes, Office
 * and text sources. `connecting` is the first handshake only (the note body
 * waits for it); later drops read `reconnecting` and keep the editor. */
export type NoteEditorSaveState =
  | 'connecting'
  | 'reconnecting'
  | 'syncing'
  | 'synced'
  | 'saved'
  | 'offline'
  /** A save failed and the server is retrying; the editor keeps its edits. */
  | 'unsaved'
  | 'error';

/** Transient chrome status for the note editor (header, not toolbar). */
export type NoteEditorStatus = {
  saveState: NoteEditorSaveState;
};

export function noteEditorStatusLabel(
  status: NoteEditorStatus | null | undefined
): string | null {
  if (!status) return null;
  switch (status.saveState) {
    case 'connecting':
      return m.editor_connecting();
    case 'reconnecting':
      return m.editor_status_reconnecting();
    case 'syncing':
      return m.editor_status_syncing();
    case 'synced':
      return m.editor_status_synced();
    case 'saved':
      return m.editor_status_saved();
    case 'offline':
      return m.editor_status_offline();
    case 'unsaved':
      return m.editor_status_unsaved();
    case 'error':
      return m.editor_status_unavailable();
  }
}

export function isEditorCommandAllowed(
  command: { widget?: string },
  allowExternalAssets: boolean
): boolean {
  return allowExternalAssets || command.widget !== 'media';
}
