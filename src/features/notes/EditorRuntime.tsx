import { createContext, useContext } from 'react';
import type { WorkspaceRole } from '@/api/types';
import type { NoteEditorMode } from './editorMode';

export interface EditorRuntimeValue {
  /** Structural workspace permission used to gate uploads and other side effects. */
  allowExternalAssets: boolean;
  canComment: boolean;
  canEdit: boolean;
  currentUserId: string | null;
  materialId: string;
  mode: NoteEditorMode;
  role: WorkspaceRole | null;
  workspaceId: string;
}

const EditorRuntimeContext = createContext<EditorRuntimeValue | null>(null);

export function EditorRuntimeProvider({
  value,
  children,
}: {
  value: EditorRuntimeValue;
  children: React.ReactNode;
}) {
  return (
    <EditorRuntimeContext.Provider value={value}>
      {children}
    </EditorRuntimeContext.Provider>
  );
}

export function useEditorRuntime() {
  const value = useContext(EditorRuntimeContext);
  if (!value) throw new Error('EditorRuntimeProvider is missing');
  return value;
}
