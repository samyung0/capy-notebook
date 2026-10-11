import type { CreateWorkspaceReq, Workspace } from '@/api/types';
import { WorkspaceFormDialog } from './WorkspaceFormDialog';

export function WorkspaceFormCreateDialog(props: {
  open: boolean;
  setOpen: (open: boolean) => void;
  workspace: CreateWorkspaceReq;
  onSubmit: (values: CreateWorkspaceReq) => Promise<Workspace | void>;
}) {
  return (
    <WorkspaceFormDialog
      {...props}
      mode="create"
      onSubmit={({ cover, ...values }) =>
        props.onSubmit({ ...values, ...(cover ? { cover } : {}) })
      }
    />
  );
}
