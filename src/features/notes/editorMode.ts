import { m } from '@/i18n';

export type NoteEditorSaveState =
  | 'connecting'
  | 'synced'
  | 'saved'
  | 'offline'
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
    case 'synced':
      return m.editor_status_synced();
    case 'saved':
      return m.editor_status_saved();
    case 'offline':
      return m.editor_status_offline();
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
