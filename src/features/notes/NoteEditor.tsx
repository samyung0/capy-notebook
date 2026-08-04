import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import {
  useMaterial,
  useMaterialCollaborationToken,
  useMaterialDiscussions,
  useMe,
  useWorkspaceMembers,
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

export function NoteEditor({
  materialId,
  mode,
  allowExternalAssets = false,
  onEditorStatusChange,
  collaborationActionsHost,
}: {
  materialId: string;
  mode: NoteEditorMode;
  allowExternalAssets?: boolean;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  collaborationActionsHost?: HTMLElement | null;
}) {
  const { data: material, isLoading } = useMaterial(materialId);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
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
      collaborationActionsHost={collaborationActionsHost}
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
  collaborationActionsHost,
}: {
  material: Material;
  mode: NoteEditorMode;
  allowExternalAssets: boolean;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  collaborationActionsHost?: HTMLElement | null;
}) {
  const queryClient = useQueryClient();
  const me = useMe();
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
      void queryClient.invalidateQueries({
        queryKey: ['material', material.id, 'collaboration-token'],
      });
    },
    [material.id, queryClient]
  );
  const role: WorkspaceRole | null =
    material.role ?? (material.isOwner ? 'owner' : null);
  // Mentions/comments need the member directory for any collaborator, not only
  // owners who can manage invites (`canManageMembers`).
  const members = useWorkspaceMembers(material.workspaceId);
  const discussions = useMaterialDiscussions(material.id);
  const collaborationToken = useMaterialCollaborationToken(material.id);
  const canEdit = material.capabilities.canEdit;
  const canComment = material.capabilities.canComment || canEdit;
  const users = useMemo(
    () =>
      Object.fromEntries(
        (members.data ?? []).map((member) => [member.userId, member])
      ),
    [members.data]
  );

  if (
    me.isPending ||
    members.isPending ||
    discussions.isPending ||
    collaborationToken.isPending
  ) {
    return <FileLoading />;
  }

  if (!me.data || me.isError) {
    return (
      <FileError message="Unable to load user info. Please refresh the page." />
    );
  }

  if (!members.data || members.isError) {
    return (
      <FileError message="Unable to load members info. Please refresh the page." />
    );
  }

  if (!collaborationToken.data || collaborationToken.isError) {
    return (
      <FileError message="The live collaboration service is unavailable." />
    );
  }

  const runtime: EditorRuntimeValue = {
    allowExternalAssets,
    canComment,
    canEdit,
    currentUserId: me.data?.id ?? null,
    materialId: material.id,
    mode,
    role,
    workspaceId: material.workspaceId,
  };

  return (
    <EditorRuntimeProvider value={runtime}>
      <div className="flex h-full flex-col gap-0 overflow-hidden">
        <NoteEditorCore
          allowExternalAssets={allowExternalAssets}
          collaborationActionsHost={collaborationActionsHost}
          collaborationToken={collaborationToken.data}
          currentUserId={me.data?.id ?? null}
          currentUserName={me.data?.name ?? null}
          discussions={discussions.data ?? []}
          key={`${collaborationToken.data.room}:${editorGeneration}`}
          material={material}
          mode={mode}
          onDocumentRejected={onDocumentRejected}
          onEditorStatusChange={onEditorStatusChange}
          users={users}
        />
      </div>
    </EditorRuntimeProvider>
  );
}
