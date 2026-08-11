import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { isMaterialContentUnreadable } from '@/api/client';
import {
  useMaterial,
  useMaterialCollaborationToken,
  useMaterialDiscussions,
  useMe,
} from '@/api/hooks';
import type { Material, WorkspaceRole } from '@/api/types';
import { Spinner } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { FileError, FileLoading } from '@/features/files/FileStates';
import {
  EditorRuntimeProvider,
  type EditorRuntimeValue,
} from './EditorRuntime';
import type { NoteEditorMode, NoteEditorStatus } from './editorMode';
import { NoteEditorCore } from './NoteEditorCore';

/** Shared so a pending discussions query does not hand the editor a new array
 * identity on every render. */
const NO_DISCUSSIONS: NonNullable<
  ReturnType<typeof useMaterialDiscussions>['data']
> = [];

export function NoteEditor({
  materialId,
  mode,
  allowExternalAssets = false,
  onEditorStatusChange,
}: {
  materialId: string;
  mode: NoteEditorMode;
  allowExternalAssets?: boolean;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
}) {
  const {
    data: material,
    error,
    isLoading,
  } = useMaterial(materialId, {
    errorBoundary: false,
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (isMaterialContentUnreadable(error)) {
    return (
      <FileError
        message="Its stored content could not be decoded, so nothing is shown rather than an empty page. Support can recover it from an earlier version."
        title="This note could not be loaded"
      />
    );
  }
  if (!material) {
    return (
      <FileError
        message="This note may have been deleted."
        title="Note not found"
      />
    );
  }

  const modeAllowed =
    (mode === 'edit' && material.capabilities.canEdit) ||
    (mode === 'comment' &&
      (material.capabilities.canEdit || material.capabilities.canComment));
  if (!modeAllowed) {
    return (
      <FileError
        message="Your current material permissions do not allow this mode."
        title="Mode unavailable"
      />
    );
  }

  return (
    <CollaborativeNoteEditor
      allowExternalAssets={allowExternalAssets}
      key={`${material.id}:${mode}`}
      material={material}
      mode={mode}
      onEditorStatusChange={onEditorStatusChange}
    />
  );
}

function CollaborativeNoteEditor({
  material,
  mode,
  allowExternalAssets,
  onEditorStatusChange,
}: {
  material: Material;
  mode: NoteEditorMode;
  allowExternalAssets: boolean;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
}) {
  const qc = useQueryClient();
  const {
    data: meData,
    isError: meIsError,
    isPending: meIsPending,
  } = useMe({
    errorBoundary: false,
  });
  // The collaboration service discards a room whose document breaks the
  // material limits, so the local Y.Doc becomes a fork the moment that happens.
  // Remounting is the only way back onto the authoritative state: invalidating
  // the token alone can return the same room and leave this editor mounted.
  const [editorGeneration, setEditorGeneration] = useState(0);
  const onDocumentRejected = useCallback(
    (message: string) => {
      userToast({
        description: `${message} Recent changes were discarded and the note was reloaded from the last saved version.`,
        title: 'Note too large to save',
        variant: 'error',
      });
      setEditorGeneration((generation) => generation + 1);
      void qc.invalidateQueries({
        queryKey: ['material', material.id, 'collaboration-token'],
      });
    },
    [qc, material.id]
  );
  const role: WorkspaceRole | null =
    material.role ?? (material.isOwner ? 'owner' : null);
  const { data: discussionsData, isPending: discussionsIsPending } =
    useMaterialDiscussions(material.id, { errorBoundary: false });
  const {
    data: collaborationTokenData,
    isError: collaborationTokenIsError,
    isPending: collaborationTokenIsPending,
  } = useMaterialCollaborationToken(material.id, true, {
    errorBoundary: false,
  });
  const canEdit = material.capabilities.canEdit;
  const canComment = material.capabilities.canComment || canEdit;
  // Identity matters more than the allocation: this context is read from inside
  // the document tree, so a fresh object on every render makes React walk every
  // node's fiber looking for consumers instead of bailing out at the top.
  const currentUserId = meData?.id ?? null;
  const runtime = useMemo<EditorRuntimeValue>(
    () => ({
      allowExternalAssets,
      canComment,
      canEdit,
      currentUserId,
      materialId: material.id,
      mode,
      role,
      workspaceId: material.workspaceId,
    }),
    [
      allowExternalAssets,
      canComment,
      canEdit,
      currentUserId,
      material.id,
      material.workspaceId,
      mode,
      role,
    ]
  );

  if (meIsPending || discussionsIsPending || collaborationTokenIsPending) {
    return <FileLoading />;
  }

  if (!meData || meIsError) {
    return (
      <FileError message="Unable to load user info. Please refresh the page." />
    );
  }

  if (!collaborationTokenData || collaborationTokenIsError) {
    return (
      <FileError message="The live collaboration service is unavailable." />
    );
  }

  return (
    <EditorRuntimeProvider value={runtime}>
      <div className="flex h-full flex-col gap-0 overflow-hidden">
        <NoteEditorCore
          allowExternalAssets={allowExternalAssets}
          collaborationToken={collaborationTokenData}
          currentUserId={meData.id}
          currentUserName={meData.name}
          discussions={discussionsData ?? NO_DISCUSSIONS}
          key={`${collaborationTokenData.room}:${editorGeneration}`}
          material={material}
          mode={mode}
          onDocumentRejected={onDocumentRejected}
          onEditorStatusChange={onEditorStatusChange}
        />
      </div>
    </EditorRuntimeProvider>
  );
}
