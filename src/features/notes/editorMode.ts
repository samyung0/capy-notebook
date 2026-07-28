import type { MaterialMode } from '@/features/materials/modePolicy';

export type NoteEditorMode = Extract<MaterialMode, 'edit' | 'suggestion'>;

export type NoteEditorSaveState = 'saved' | 'pending' | 'saving' | 'error';

/** Transient chrome status for the note editor (header, not toolbar). */
export type NoteEditorStatus =
  | { mode: 'edit'; saveState: NoteEditorSaveState }
  | { mode: 'suggestion'; dirty: boolean };

export function noteEditorStatusLabel(
  status: NoteEditorStatus | null | undefined
): string | null {
  console.log(status);
  if (!status) return null;
  if (status.mode === "suggestion") return status.dirty ? "Drafting" : "Saved";
  switch (status.saveState) {
    case 'saved':
      return 'Saved';
    case 'pending':
      return 'Unsaved';
    case 'saving':
      return 'Saving…';
    case 'error':
      return 'Save conflict or failure';
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
  return (
    canCreateExternalEditorAssets(mode, structurallyAllowed) ||
    command.widget !== 'media'
  );
}
