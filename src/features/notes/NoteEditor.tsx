import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isApiError, isMaterialContentUnreadable, qk } from '@/api/client';
import {
  useMaterial,
  useMaterialCollaborationToken,
  useMaterialDiscussions,
  useMe,
} from '@/api/hooks';
import type { Material, WorkspaceRole } from '@/api/types';
import {
  SaveBanner,
  type SaveBannerState,
} from '@/components/banners/SaveBanner';
import { Spinner } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { FileError, FileLoading } from '@/features/files/FileStates';
import { MaterialRenderProvider } from '@/features/materials/MaterialRenderContext';
import { m } from '@/i18n';
import { deleteDocumentDrafts, draftKey } from '@/lib/editDrafts';
import {
  type MaterialLimitCode,
  materialLimitMessage,
} from './collaborationEvents';
import {
  EditorRuntimeProvider,
  type EditorRuntimeValue,
} from './EditorRuntime';
import type { NoteEditorStatus } from './editorMode';
import { NoteEditorCore, type NoteOfflineState } from './NoteEditorCore';
import { NoteRecovery, useNoteDrafts } from './NoteRecovery';
import { toastSaveUndone } from './saveFailure';

/** Shared so a pending discussions query does not hand the editor a new array
 * identity on every render. */
const NO_DISCUSSIONS: NonNullable<
  ReturnType<typeof useMaterialDiscussions>['data']
> = [];

export function NoteEditor({
  materialId,
  allowExternalAssets = false,
  onEditorStatusChange,
  onReadOnly,
}: {
  materialId: string;
  allowExternalAssets?: boolean;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  /** The room turned read-only: the note drops to view mode and its unsaved
   * edits are discarded. */
  onReadOnly?: () => void;
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
        message={m.material_decode_body()}
        title={m.material_decode_title()}
      />
    );
  }
  if (!material) {
    return (
      <FileError
        message={m.editor_note_deleted()}
        title={m.editor_note_not_found()}
      />
    );
  }

  if (!material.capabilities.canEditContent) {
    return (
      <FileError
        icon="securityWarning"
        message={m.editor_mode_unavailable_body()}
        title={m.editor_mode_unavailable()}
      />
    );
  }

  return (
    <CollaborativeNoteEditor
      allowExternalAssets={allowExternalAssets}
      key={material.id}
      material={material}
      onEditorStatusChange={onEditorStatusChange}
      onReadOnly={onReadOnly}
    />
  );
}

function CollaborativeNoteEditor({
  material,
  allowExternalAssets,
  onEditorStatusChange,
  onReadOnly,
}: {
  material: Material;
  allowExternalAssets: boolean;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  onReadOnly?: () => void;
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
  // Saves are failing or unconfirmed while the editor keeps its edits.
  const [saveDelayed, setSaveDelayed] = useState(false);
  // The room cannot be reached; the edits stay on this device.
  const [offline, setOffline] = useState<NoteOfflineState | null>(null);
  const banner: SaveBannerState | null =
    offline ?? (saveDelayed ? 'delayed' : null);
  const onDocumentRejected = useCallback(
    (
      code: MaterialLimitCode | 'invalid_document' | 'revoked',
      edits: 'none' | 'kept' | 'lost'
    ) => {
      if (code !== 'invalid_document' && code !== 'revoked')
        userToast({
          description: m.editor_too_large_body({
            message: materialLimitMessage(code),
          }),
          title: m.editor_too_large_title(),
          variant: 'error',
        });
      // Kept edits open read-only for copying after the remount.
      if (edits === 'lost') toastSaveUndone();
      setSaveDelayed(false);
      setOffline(null);
      setEditorGeneration((generation) => generation + 1);
      void qc.invalidateQueries({
        queryKey: ['material', material.id, 'collaboration-token'],
      });
    },
    [qc, material.id]
  );
  // Trashed, deleted, or access lost while open: the room refused to let the
  // editor back in.
  const [unavailable, setUnavailable] = useState<
    'notFound' | 'forbidden' | null
  >(null);
  const storedKey = meData
    ? draftKey(meData.id, 'material', material.id)
    : null;
  const onUnavailable = useCallback(
    (kind: 'notFound' | 'forbidden') => {
      // The user no longer has this note: its stored edits go too.
      if (storedKey)
        void deleteDocumentDrafts(storedKey).catch(() => undefined);
      setUnavailable(kind);
      void qc.invalidateQueries({ queryKey: qk.material(material.id) });
      if (material.workspaceId)
        void qc.invalidateQueries({
          queryKey: qk.materials(material.workspaceId),
        });
    },
    [qc, material.id, material.workspaceId, storedKey]
  );
  const reportReadOnly = useCallback(() => {
    // Capabilities and the storage status follow from the refreshed reads.
    void qc.invalidateQueries({ queryKey: qk.material(material.id) });
    void qc.invalidateQueries({ queryKey: qk.me });
    if (material.workspaceId)
      void qc.invalidateQueries({
        queryKey: qk.workspace(material.workspaceId),
      });
    onReadOnly?.();
  }, [qc, material.id, material.workspaceId, onReadOnly]);
  const role: WorkspaceRole | null =
    material.role ?? (material.isOwner ? 'owner' : null);
  const { data: discussionsData, isPending: discussionsIsPending } =
    useMaterialDiscussions(material.id, { errorBoundary: false });
  const {
    data: collaborationTokenData,
    error: collaborationTokenError,
    isPending: collaborationTokenIsPending,
    refetch: refetchCollaborationToken,
  } = useMaterialCollaborationToken(material.id, true, {
    errorBoundary: false,
  });
  const canEdit = material.capabilities.canEditContent;
  const drafts = useNoteDrafts(
    storedKey,
    collaborationTokenData?.room,
    editorGeneration
  );
  const tokenStatus = isApiError(collaborationTokenError)
    ? collaborationTokenError.status
    : 0;
  useEffect(() => {
    if (storedKey && (tokenStatus === 403 || tokenStatus === 404))
      void deleteDocumentDrafts(storedKey).catch(() => undefined);
  }, [storedKey, tokenStatus]);
  // Identity matters more than the allocation: this context is read from inside
  // the document tree, so a fresh object on every render makes React walk every
  // node's fiber looking for consumers instead of bailing out at the top.
  const currentUserId = meData?.id ?? null;
  const runtime = useMemo<EditorRuntimeValue>(
    () => ({
      allowExternalAssets,
      canEdit,
      currentUserId,
      materialId: material.id,
      role,
      workspaceId: material.workspaceId,
    }),
    [
      allowExternalAssets,
      canEdit,
      currentUserId,
      material.id,
      material.workspaceId,
      role,
    ]
  );
  const renderContext = useMemo(
    () => ({
      isStandalone: !material.workspaceId,
      kind: material.kind,
      title: material.title,
    }),
    [material.kind, material.title, material.workspaceId]
  );

  if (unavailable === 'notFound')
    return (
      <FileError
        message={m.editor_note_deleted()}
        title={m.editor_note_not_found()}
      />
    );
  if (unavailable === 'forbidden')
    return (
      <FileError
        icon="securityWarning"
        message={m.editor_access_lost_body()}
        title={m.editor_access_lost()}
      />
    );

  if (meIsPending || discussionsIsPending || collaborationTokenIsPending) {
    return <FileLoading />;
  }

  if (!meData || meIsError) {
    return <FileError icon="error" message={m.editor_user_info_failed()} />;
  }

  // Only a first request can fail here: once the editor holds a room, a new
  // token rides the open connection instead.
  if (!collaborationTokenData) {
    const status = tokenStatus;
    return status === 404 ? (
      <FileError
        message={m.editor_note_deleted()}
        title={m.editor_note_not_found()}
      />
    ) : status === 403 ? (
      <FileError
        icon="securityWarning"
        message={m.editor_access_lost_body()}
        title={m.editor_access_lost()}
      />
    ) : (
      <FileError
        icon="error"
        message={m.editor_collab_unavailable()}
        onRetry={() => void refetchCollaborationToken()}
      />
    );
  }

  // Stored edits are read for each room and mount before the editor opens.
  if (
    !(storedKey && drafts) ||
    drafts.for !== `${collaborationTokenData.room}:${editorGeneration}`
  )
    return <FileLoading />;

  return (
    <MaterialRenderProvider value={renderContext}>
      <EditorRuntimeProvider value={runtime}>
        <div className="flex h-full flex-col gap-0 overflow-hidden">
          {drafts.recovery ? (
            <NoteRecovery
              material={material}
              onEditorStatusChange={onEditorStatusChange}
              onReload={() => setEditorGeneration((value) => value + 1)}
              recovery={drafts.recovery}
            />
          ) : (
            <>
              {banner && <SaveBanner state={banner} />}
              <NoteEditorCore
                allowExternalAssets={allowExternalAssets}
                collaborationToken={collaborationTokenData}
                currentUserId={meData.id}
                currentUserName={meData.name}
                discussions={discussionsData ?? NO_DISCUSSIONS}
                draftKey={storedKey}
                key={`${collaborationTokenData.room}:${editorGeneration}`}
                material={material}
                onDocumentRejected={onDocumentRejected}
                onEditorStatusChange={onEditorStatusChange}
                onOffline={setOffline}
                onReadOnly={reportReadOnly}
                onSaveDelayed={setSaveDelayed}
                onUnavailable={onUnavailable}
                restored={drafts.current}
              />
            </>
          )}
        </div>
      </EditorRuntimeProvider>
    </MaterialRenderProvider>
  );
}
