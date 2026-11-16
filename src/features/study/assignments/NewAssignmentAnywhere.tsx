import { useState } from 'react';
import { useWorkspaces } from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { NewAssignmentDialog } from './LazyNewAssignmentDialog';

/** To do's Add task (Epo 2026-11-10; the Workspace option, 2026-11-11): the
 * one form opens at once as a task with no workspace, and its first field,
 * Workspace, puts it in one of the workspaces the caller is a member of. The
 * fields follow the workspace in place: a class's staff get the assignment's,
 * everyone else and no workspace a task for oneself. Outside a workspace the
 * words are the same for everyone (Epo 2026-11-10), so nothing here says class
 * or assignment. */
export function NewAssignmentAnywhere() {
  const { data: workspaces } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button iconLeft="plus" onClick={() => setOpen(true)}>
        {m.todo_add_task()}
      </Button>
      {open && (
        <NewAssignmentDialog
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            // A class's shows in To do only when it names its maker.
            userToast({ title: m.todo_task_added(), variant: 'success' });
          }}
          title={m.todo_add_task()}
          workspaceId=""
          workspaces={(workspaces ?? []).filter((ws) => ws.role)}
        />
      )}
    </>
  );
}
