import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useCloneWorkspace } from '@/api/hooks';
import type { PublicWorkspace } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { trackItemCloned } from '@/lib/analytics';
import { toastCloneError } from '@/lib/authToasts';
import { WorkspaceFormDialog } from './WorkspaceFormDialog';

/** Clone asks for the copy's name, description, icon, tags and cover,
 * prefilled from the source, and opens the copy once it exists. */
export function CloneWorkspaceDialog({
  open,
  setOpen,
  workspace,
  onCloned,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  workspace: Pick<
    PublicWorkspace,
    | 'chapterCount'
    | 'cover'
    | 'description'
    | 'fileCount'
    | 'iconId'
    | 'id'
    | 'isOwner'
    | 'name'
    | 'tags'
  >;
  /** Runs before the app opens the copy. */
  onCloned?: () => void;
}) {
  const navigate = useNavigate();
  const { mutateAsync: cloneWorkspace } = useCloneWorkspace({
    errorToast: false,
  });
  // No id: the copy's cover art previews and saves with a fresh seed.
  const draft = useMemo(
    () => ({
      chapterCount: workspace.chapterCount,
      cover: workspace.cover,
      description: workspace.description,
      fileCount: workspace.fileCount,
      iconId: workspace.iconId,
      // An owner's copy sits next to the source, so its name tells them apart.
      name: workspace.isOwner
        ? m.workspace_copy_name({ name: workspace.name })
        : workspace.name,
      // Tag ids are the source owner's; the copy reuses or creates by value.
      tags: workspace.tags.map(({ value }) => ({ value })),
    }),
    [workspace]
  );
  return (
    <WorkspaceFormDialog
      mode="clone"
      onSubmit={async ({ cover, ...values }) => {
        const { workspace: cloned } = await cloneWorkspace(
          {
            body: { ...values, ...(cover ? { cover } : {}) },
            id: workspace.id,
          },
          { onError: (err) => toastCloneError(err, 'workspace') }
        );
        trackItemCloned('workspace');
        userToast({ title: m.workspace_cloned(), variant: 'success' });
        onCloned?.();
        await navigate({
          params: { workspaceId: cloned.id },
          to: '/workspaces/$workspaceId',
        });
      }}
      open={open}
      setOpen={setOpen}
      workspace={draft}
    />
  );
}
