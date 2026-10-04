import { useCallback } from 'react';
import { useWorkspace, useWorkspaceMembers } from '@/api/hooks';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/**
 * Whether the viewer is the only one who can edit: the owner of a standalone
 * item (`standaloneOwner`), or of a workspace with no edit link and no other
 * editing member. Until
 * that is known the answer is no, which asks for a reload rather than
 * promising a retry that a collaborator's edits could outrun.
 */
function useSoleEditor(
  workspaceId: string | null | undefined,
  standaloneOwner: boolean
) {
  const { data: workspace } = useWorkspace(workspaceId ?? '', {
    errorBoundary: false,
  });
  const { data: members } = useWorkspaceMembers(
    workspaceId ?? '',
    !!workspace?.isOwner,
    { errorBoundary: false }
  );
  if (!workspaceId) return standaloneOwner;
  if (!(workspace?.isOwner && members)) return false;
  const editLink =
    workspace.privacy !== 'private' && workspace.shareRole === 'editor';
  return (
    !editLink &&
    members.every(
      (member) => member.role === 'owner' || member.role === 'viewer'
    )
  );
}

/**
 * A failed save's toast. `delayed`: a source save failing slowly (the room
 * stays editable while the server retries with backoff). `retrying`: the server keeps retrying while the
 * editor holds the edits; a sole editor can keep working, anyone else should
 * reload. `undone`: the edits could not be saved and the editor went back to
 * the last saved version.
 */
export function useSaveFailureToast(
  workspaceId: string | null | undefined,
  standaloneOwner = false
) {
  const soleEditor = useSoleEditor(workspaceId, standaloneOwner);
  return useCallback(
    (kind: 'retrying' | 'undone' | 'delayed') => {
      // A slow save failure (the server keeps retrying): editing goes on
      // and reloading would not help.
      if (kind === 'delayed') {
        userToast({
          description: m.editor_save_delayed_description(),
          id: 'save-failed',
          title: m.editor_save_delayed(),
          variant: 'error',
        });
        return;
      }
      if (kind === 'undone') {
        userToast({
          description: m.editor_save_failed_undone(),
          id: 'save-failed',
          title: m.editor_save_failed(),
          variant: 'error',
        });
        return;
      }
      userToast({
        ...(!soleEditor && {
          button: {
            label: m.error_action_reload(),
            onClick: () => window.location.reload(),
          },
        }),
        description: soleEditor
          ? m.editor_save_failed_retrying()
          : m.editor_save_failed_reload(),
        id: 'save-failed',
        title: m.editor_save_failed(),
        variant: 'error',
      });
    },
    [soleEditor]
  );
}
