import { useMemo } from 'react';
import { useUpdateTask } from '@/api/hooks';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { OnboardingDialog } from '@/features/auth/OnboardingDialog';
import { TaskEditDialog } from '@/features/tasks/TaskEditDialog';
import {
  AddSourceDialog,
  type PendingSource,
} from '@/features/workspace/AddSourceDialog';
import { WorkspaceTransferDialog } from '@/features/workspace/WorkspaceMemberManager';
import { WorkspaceSettingsDialog } from '@/features/workspace/WorkspaceSettingsDialog';
import { tasks, workspaces } from '@/mocks/db';
import { scenarioWorkspace } from '@/mocks/scenarioFixtures';
import type { MockDialogId } from './mockDialogOptions';

const source: PendingSource = {
  analysisStatus: 'ready',
  chapterId: null,
  chapterName: null,
  contentType: 'text/plain',
  fileId: 'mock_drive_file',
  key: 'mock-dialog-source',
  kind: 'txt',
  name: 'Study notes.txt',
  origin: 'remote',
  parseMode: 'none',
  provider: 'google',
  sizeBytes: 2048,
  sizeEstimate: false,
};

export default function MockDialogPreview({
  dialog,
  onClose,
}: {
  dialog: MockDialogId;
  onClose: () => void;
}) {
  const initialSources = useMemo<PendingSource[]>(
    () => [
      dialog === 'source-upload'
        ? {
            ...source,
            file: new File(['Scenario upload'], 'Scenario upload.txt', {
              type: 'text/plain',
            }),
            name: 'Scenario upload.txt',
            origin: 'local',
            parseMode: 'none',
            sizeBytes: 15,
          }
        : source,
    ],
    [dialog]
  );
  // Product dialogs use the same dedicated workspace as page journeys.
  const workspaceId = scenarioWorkspace;
  const workspace = workspaces.find((item) => item.id === workspaceId)!;
  const { mutateAsync: updateTask } = useUpdateTask();
  if (
    dialog === 'workspace-stats' ||
    dialog === 'workspace-settings' ||
    dialog === 'workspace-sharing'
  )
    return (
      <WorkspaceSettingsDialog
        initialTab={
          dialog === 'workspace-stats'
            ? 'statistics'
            : dialog === 'workspace-sharing'
              ? 'sharing'
              : 'general'
        }
        onClose={onClose}
        open
        workspace={workspace}
      />
    );
  if (dialog === 'task-edit')
    return (
      <TaskEditDialog
        onClose={onClose}
        onSave={(patch) => updateTask({ ...patch, id: 'mock-scenario-task' })}
        open
        task={tasks.find((task) => task.id === 'mock-scenario-task')!}
      />
    );
  if (dialog === 'ownership-transfer')
    return (
      <WorkspaceTransferDialog
        member={{
          createdAt: '2026-09-15T00:00:00Z',
          name: 'Morgan Lee',
          role: 'editor',
          userId: 'u_mock_collaborator',
          workspaceId,
        }}
        onClose={onClose}
        workspaceId={workspaceId}
      />
    );
  return (
    <AppErrorBoundary>
      {dialog === 'onboarding' ? (
        <OnboardingDialog />
      ) : (
        <AddSourceDialog
          initialMode={dialog === 'source-details' ? 'import' : 'upload'}
          initialSources={dialog === 'source-chooser' ? [] : initialSources}
          onClose={onClose}
          open
          workspaceId={workspaceId}
        />
      )}
    </AppErrorBoundary>
  );
}
