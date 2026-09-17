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
      onSubmit={(values) => onSubmit({ ...values, tags: values.tags ?? [] })}
    />
  );
}
