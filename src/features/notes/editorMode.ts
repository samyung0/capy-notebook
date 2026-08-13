import type { MaterialMode } from '@/features/materials/modePolicy';
import { m } from '@/i18n';

export type NoteEditorMode = Extract<MaterialMode, 'edit' | 'comment'>;

export type NoteEditorSaveState =
  | 'connecting'
  | 'synced'
  | 'saved'
  | 'offline'
  | 'error';

/** Transient chrome status for the note editor (header, not toolbar). */
export type NoteEditorStatus = {
  mode: NoteEditorMode;
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

export function canCreateExternalEditorAssets(
  mode: NoteEditorMode,
  structurallyAllowed = true
): boolean {
  return structurallyAllowed && mode === 'edit';
}

export function isEditorCommandAllowed(
  mode: NoteEditorMode,
  command: { widget?: string },
  structurallyAllowed = true
): boolean {
  if (mode !== 'edit') return false;
  return (
    canCreateExternalEditorAssets(mode, structurallyAllowed) ||
    command.widget !== 'media'
  );
}
