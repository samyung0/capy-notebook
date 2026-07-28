import {
  useMaterial,
  useMaterialDiscussions,
  useMe,
  useWorkspaceMembers,
} from "@/api/hooks";
import type { Material, WorkspaceRole } from "@/api/types";
import { EmptyState, Spinner } from "@/components/ui";
import { useMemo } from "react";
import { FileLoading } from "../materials/CenterContent";
import type { NoteEditorMode, NoteEditorStatus } from "./editorMode";
import {
  EditorRuntimeProvider,
  type EditorRuntimeValue,
} from "./EditorRuntime";
import { NoteEditorCore } from "./NoteEditorCore";

export function NoteEditor({
  materialId,
  mode,
  allowExternalAssets = false,
  onSuggestionDirtyChange,
  onEditorStatusChange,
  collaborationActionsHost,
}: {
  materialId: string;
  mode: NoteEditorMode;
  allowExternalAssets?: boolean;
  onSuggestionDirtyChange?: (dirty: boolean) => void;
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
    (mode === "edit" && material.capabilities.canEdit) ||
    (mode === "suggestion" &&
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
      onSuggestionDirtyChange={onSuggestionDirtyChange}
    />
  );
}

function CollaborativeNoteEditor({
  material,
  mode,
  allowExternalAssets,
  onSuggestionDirtyChange,
  onEditorStatusChange,
  collaborationActionsHost,
}: {
  material: Material;
  mode: NoteEditorMode;
  allowExternalAssets: boolean;
  onSuggestionDirtyChange?: (dirty: boolean) => void;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  collaborationActionsHost?: HTMLElement | null;
}) {
  const me = useMe();
  const role: WorkspaceRole | null =
    material.role ?? (material.isOwner ? "owner" : null);
  // Mentions/comments need the member directory for any collaborator, not only
  // owners who can manage invites (`canManageMembers`).
  const members = useWorkspaceMembers(material.workspaceId);
  const discussions = useMaterialDiscussions(material.id);
  const canEdit = material.capabilities.canEdit;
  const canComment = material.capabilities.canComment || canEdit;
  const users = useMemo(
    () =>
      Object.fromEntries(
        (members.data ?? []).map((member) => [member.userId, member]),
      ),
    [members.data],
  );

  if (me.isPending || members.isPending || discussions.isPending) {
    return <FileLoading />;
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
      <div className="h-full overflow-hidden flex flex-col gap-0">
        <NoteEditorCore
          allowExternalAssets={allowExternalAssets}
          collaborationActionsHost={collaborationActionsHost}
          currentUserId={me.data?.id ?? null}
          discussions={discussions.data ?? []}
          material={material}
          mode={mode}
          onEditorStatusChange={onEditorStatusChange}
          onSuggestionDirtyChange={onSuggestionDirtyChange}
          users={users}
        />
        {/* TODO: replace this div with the suggestion summary */}
        <div className="bg-red-500">dasdasdasdasdasdas</div>
      </div>
    </EditorRuntimeProvider>
  );
}
