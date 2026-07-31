import type { MaterialMode } from '@/features/materials/modePolicy';

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
      return 'Connecting…';
    case 'synced':
      return 'Synced';
    case 'saved':
      return 'Saved';
    case 'offline':
      return 'Offline';
    case 'error':
      return 'Collaboration unavailable';
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
