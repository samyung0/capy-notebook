import {
  useCreateEvent,
  useCreateWorkspace,
  useLabels,
  useUpdateEvent,
  useUpdateLabel,
  useUpdateTask,
  useUpdateWorkspace,
} from '@/api/hooks';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { EventDetailDialog } from '@/features/schedule/EventDetailDialog';
import { EventFormDialog } from '@/features/schedule/EventFormDialog';
import { LabelEditDialog } from '@/features/schedule/LabelEditDialog';
import { TaskEditDialog } from '@/features/tasks/TaskEditDialog';
import { AddSourceDialog } from '@/features/workspace/AddSourceDialog';
import { OneDriveImportDialog } from '@/features/workspace/OneDriveImportDialog';
import { WorkspaceFormCreateDialog } from '@/features/workspace/WorkspaceFormCreateDialog';
import { WorkspaceFormEditDialog } from '@/features/workspace/WorkspaceFormEditDialog';
import { WorkspaceStatsDialog } from '@/features/workspace/WorkspaceStatsDialog';
import { m } from '@/i18n';
import { usePortals } from '@/stores/portals';
import { userToast } from '../ui/userToast';
import { SearchDialog } from './TopInsetBar';

export function GlobalDialogs() {
  const workspaceCreate = usePortals((s) => s.workspaceCreate);
  const workspaceEdit = usePortals((s) => s.workspaceEdit);
  const workspaceId = usePortals((s) => s.workspaceId);
  const workspaceStatsId = usePortals((s) => s.workspaceStatsId);
  const taskEdit = usePortals((s) => s.taskEdit);
  const labelEdit = usePortals((s) => s.labelEdit);
  const eventForm = usePortals((s) => s.eventForm);
  const eventDetail = usePortals((s) => s.eventDetail);
  const addSource = usePortals((s) => s.addSource);
  const msImport = usePortals((s) => s.msImport);
  const confirm = usePortals((s) => s.confirm);
  const openWorkspaceCreate = usePortals((s) => s.openWorkspaceCreate);
  const openWorkspaceEdit = usePortals((s) => s.openWorkspaceEdit);
  const openEventForm = usePortals((s) => s.openEventForm);
  const closeWorkspaceCreate = usePortals((s) => s.closeWorkspaceCreate);
  const closeWorkspaceEdit = usePortals((s) => s.closeWorkspaceEdit);
  const closeWorkspaceStats = usePortals((s) => s.closeWorkspaceStats);
  const closeTaskEdit = usePortals((s) => s.closeTaskEdit);
  const closeLabelEdit = usePortals((s) => s.closeLabelEdit);
  const closeEventForm = usePortals((s) => s.closeEventForm);
  const closeEventDetail = usePortals((s) => s.closeEventDetail);
  const closeAddSource = usePortals((s) => s.closeAddSource);
  const closeMsImport = usePortals((s) => s.closeMsImport);
  const closeConfirm = usePortals((s) => s.closeConfirm);

  const { mutateAsync: createWorkspace } = useCreateWorkspace();
  const { mutateAsync: updateWorkspace } = useUpdateWorkspace();
  const { mutateAsync: updateTask } = useUpdateTask();
  const { mutateAsync: updateLabel } = useUpdateLabel();
  const { mutateAsync: createEvent } = useCreateEvent();
  const { mutateAsync: updateEvent } = useUpdateEvent();
  const { data: labels } = useLabels({ errorBoundary: false });

  const isTopBarSearchOpen = usePortals((s) => s.isTopBarSearchOpen);
  const setTopBarSearchOpen = usePortals((s) => s.setTopBarSearchOpen);

  // TODO: split dialog into individual components to reduce re-rendering cost

  return (
    <>
      {/* TODO: fix the workspace create and edit dialog */}
      {workspaceCreate && (
        <WorkspaceFormCreateDialog
          onSubmit={async (v) => await createWorkspace(v)}
          open
          setOpen={(open) => {
            if (!open) closeWorkspaceCreate();
            if (open && !workspaceCreate) openWorkspaceCreate();
          }}
          workspace={workspaceCreate}
        />
      )}

      {workspaceEdit && (
        <WorkspaceFormEditDialog
          onSubmit={async (v) => {
            if (!workspaceId) {
              userToast({
                description: m.workspace_missing_body(),
                title: m.workspace_missing_title(),
                variant: 'error',
              });
              return;
            }
            return await updateWorkspace({ id: workspaceId, ...v });
          }}
          open
          setOpen={(open) => {
            if (!open) closeWorkspaceEdit();
            if (open && workspaceId && !workspaceEdit)
              openWorkspaceEdit(workspaceEdit, workspaceId);
          }}
          workspace={workspaceEdit}
        />
      )}

      {workspaceStatsId && (
        <WorkspaceStatsDialog
          id={workspaceStatsId}
          onClose={closeWorkspaceStats}
        />
      )}

      {taskEdit && (
        <TaskEditDialog
          key={taskEdit.id}
          onClose={closeTaskEdit}
          onSave={(patch) => updateTask({ id: taskEdit.id, ...patch })}
          open
          task={taskEdit}
        />
      )}

      {labelEdit && (
        <LabelEditDialog
          key={labelEdit.id}
          label={labelEdit}
          onClose={closeLabelEdit}
          onSave={(patch) => updateLabel({ id: labelEdit.id, ...patch })}
          open
        />
      )}

      {eventForm && (
        <EventFormDialog
          draft={eventForm}
          key={
            eventForm.id ?? `${eventForm.start ?? ''}-${eventForm.end ?? ''}`
          }
          labels={labels ?? []}
          onClose={closeEventForm}
          onSubmit={(v) =>
            eventForm.id
              ? updateEvent({ id: eventForm.id, ...v })
              : createEvent(v)
          }
          open
        />
      )}

      <EventDetailDialog
        event={eventDetail}
        labels={labels ?? []}
        onClose={closeEventDetail}
        onEdit={(ev) => {
          closeEventDetail();
          openEventForm({
            end: ev.end,
            id: ev.id,
            labelIds: ev.labelIds,
            location: ev.location,
            start: ev.start,
            title: ev.title,
          });
        }}
      />

      {addSource && (
        <AddSourceDialog
          onClose={closeAddSource}
          open
          workspaceId={addSource.workspaceId}
        />
      )}

      {msImport && (
        <OneDriveImportDialog
          onClose={closeMsImport}
          open
          workspaceId={msImport.workspaceId}
        />
      )}

      <ConfirmDialog
        body={confirm?.body}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger ?? true}
        onClose={closeConfirm}
        onConfirm={() => confirm?.onConfirm()}
        open={!!confirm}
        title={confirm?.title ?? ''}
      />

      <SearchDialog open={isTopBarSearchOpen} setOpen={setTopBarSearchOpen} />
    </>
  );
}
