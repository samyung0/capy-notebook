import type { UpdateWorkspaceReq, Workspace } from '@/api/types';
import { WorkspaceFormDialog } from './WorkspaceFormDialog';

export function WorkspaceFormEditDialog({
  onSubmit,
  ...props
}: {
  embedded?: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  workspace: Workspace;
  onSubmit: (values: UpdateWorkspaceReq) => Promise<Workspace | void>;
}) {
  return (
    <WorkspaceFormDialog
      {...props}
      mode="edit"
      // None goes out as clearCover; the API refuses cover: null.
      onSubmit={({ cover, ...values }) =>
        onSubmit({
          ...values,
          tags: values.tags ?? [],
          ...(cover ? { cover } : { clearCover: true }),
        })
      }
    />
  );
}
