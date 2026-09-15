import { useUpdateTask } from '@/api/hooks';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { SimpleDialog } from '@/components/ui/Dialog';
import { OnboardingDialog } from '@/features/auth/OnboardingDialog';
import { FileNotIndexedBanner } from '@/features/files/FileStates';
import { FileViewer } from '@/features/files/FileViewer';
import { TaskEditDialog } from '@/features/tasks/TaskEditDialog';
import {
  AddSourceDialog,
  type PendingSource,
  SourceDetailsDialog,
} from '@/features/workspace/AddSourceDialog';
import { WorkspaceMemberManager } from '@/features/workspace/WorkspaceMemberManager';
import { WorkspaceStatsDialog } from '@/features/workspace/WorkspaceStatsDialog';
import { tasks, workspaces } from '@/mocks/db';
import { dialogFiles, dialogSourceFile } from '@/mocks/dialogFiles';
import { sourceUploadPolicy } from '@/mocks/sourceUploadPolicy';

export const mockDialogOptions = [
  { id: 'workspace-stats', label: 'Workspace statistics' },
  { id: 'ownership-transfer', label: 'Transfer ownership confirmation' },
  { id: 'task-edit', label: 'Task editor' },
  ...dialogFiles.map(({ id, name }) => ({ id, label: name })),
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'source-chooser', label: 'Add sources' },
  { id: 'source-details', label: 'Import details with dummy files' },
  { id: 'source-analysis-error', label: 'Import analysis error' },
] as const;
export type MockDialogId = (typeof mockDialogOptions)[number]['id'];

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
  parseMode: 'fast',
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
  // The first seeded workspace is explicit fixture data, independent of the route.
  const workspaceId = workspaces[0].id;
  const { mutateAsync: updateTask } = useUpdateTask();
  if (dialog.startsWith('mock-preview-')) {
    const file = dialogSourceFile(dialog);
    return (
      <SimpleDialog onClose={onClose} open title={file.name} width={800}>
        <FileNotIndexedBanner file={file} />
        <div className="h-[60dvh]">
          <FileViewer file={file} />
        </div>
      </SimpleDialog>
    );
  }
  if (dialog === 'workspace-stats')
    return <WorkspaceStatsDialog id={workspaceId} onClose={onClose} />;
  if (dialog === 'task-edit')
    return (
      <TaskEditDialog
        onClose={onClose}
        onSave={(patch) => updateTask({ ...patch, id: tasks[0].id })}
        open
        task={tasks[0]}
      />
    );
  if (dialog === 'ownership-transfer')
    return (
      <SimpleDialog onClose={onClose} open title="Mock workspace members">
        <WorkspaceMemberManager
          initialTransferTarget={{
            createdAt: '2026-09-15T00:00:00Z',
            name: 'Morgan Lee',
            role: 'editor',
            userId: 'u_mock_collaborator',
            workspaceId,
          }}
          workspaceId={workspaceId}
        />
      </SimpleDialog>
    );
  return (
    <AppErrorBoundary>
      {dialog === 'onboarding' ? (
        <OnboardingDialog />
      ) : dialog === 'source-chooser' ? (
        <AddSourceDialog onClose={onClose} open workspaceId={workspaceId} />
      ) : (
        <SourceDetailsDialog
          initialSources={[
            dialog === 'source-analysis-error'
              ? {
                  ...source,
                  analysisStatus: 'error',
                  kind: 'doc',
                  name: 'Unreadable document.docx',
                }
              : source,
          ]}
          onClose={onClose}
          onEmpty={onClose}
          open
          uploadPolicy={sourceUploadPolicy}
          workspaceId={workspaceId}
        />
      )}
    </AppErrorBoundary>
  );
}
