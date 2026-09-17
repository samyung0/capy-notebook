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
import { WorkspaceTransferDialog } from '@/features/workspace/WorkspaceMemberManager';
import { WorkspaceSettingsDialog } from '@/features/workspace/WorkspaceSettingsDialog';
import { tasks, workspaces } from '@/mocks/db';
import { dialogSourceFile } from '@/mocks/dialogFiles';
import { sourceUploadPolicy } from '@/mocks/sourceUploadPolicy';
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
    return (
      <WorkspaceSettingsDialog
        initialTab="statistics"
        onClose={onClose}
        open
        workspace={workspaces[0]}
      />
    );
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
