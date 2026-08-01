import { useMemo } from 'react';
import {
  useMaterial,
  useMaterialCollaborationToken,
  useMaterialDiscussions,
  useMe,
  useWorkspaceMembers,
} from '@/api/hooks';
import type { Material, WorkspaceRole } from '@/api/types';
import { EmptyState, Spinner } from '@/components/ui/feedback';
import { FileLoading } from '@/features/files/FileStates';
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
      <EmptyState
        body="This note may have been deleted."
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
      <EmptyState
        body="Your current material permissions do not allow this mode."
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
  const me = useMe();
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
  if (!collaborationToken.data) {
    return (
      <EmptyState
        body="The live collaboration service is unavailable."
        title="Unable to open material"
      />
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
          key={collaborationToken.data.room}
          material={material}
          mode={mode}
          onEditorStatusChange={onEditorStatusChange}
          users={users}
        />
      </div>
    </EditorRuntimeProvider>
  );
}
