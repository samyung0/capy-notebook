import { m } from '@/i18n';

/** The header save/connection status of every editable file. A note or an
 * item opens painted (Epo 2026-11-04): `opening` is a spinner with no words
 * until its room's first sync, a rejoin changes nothing until its 30 s passed,
 * and `syncing-draft` is a stored draft on its way while it opens. Office and
 * text sources still read `connecting` and `reconnecting`, until the ribbon. */
export type NoteEditorSaveState =
  | 'connecting'
  | 'opening'
  | 'reconnecting'
  | 'syncing'
  | 'syncing-draft'
  | 'synced'
  | 'saved'
  | 'offline'
  /** A save failed and the server is retrying; the editor keeps its edits. */
  | 'unsaved'
  | 'error';

/** Transient chrome status for the note editor (header, not toolbar). */
export type NoteEditorStatus = {
  saveState: NoteEditorSaveState;
  /** A note on screen whose reconnect waits on the open budget: the header
   * says so under its sync indicator after 5 s (Epo 2026-10-20). */
  slowed?: boolean;
};

export function noteEditorStatusLabel(
  status: NoteEditorStatus | null | undefined
): string | null {
  if (!status) return null;
  switch (status.saveState) {
    case 'connecting':
      return m.editor_connecting();
    case 'opening':
      return m.a11y_loading();
    case 'reconnecting':
      return m.editor_status_reconnecting();
    case 'syncing':
      return m.editor_status_syncing();
    case 'syncing-draft':
      return m.editor_status_syncing_draft();
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
