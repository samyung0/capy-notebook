import { useState } from 'react';
import {
  useImportSources,
  useIntegrations,
  useMicrosoftRecentFiles,
} from '@/api/hooks';
import { SimpleDialog } from '@/components/ui';

export function OneDriveImportDialog({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}) {
  const [chapterId] = useState<string | null>(null);
  const importSources = useImportSources(workspaceId);
  const { data: integrations } = useIntegrations();
  const { data: msFiles } = useMicrosoftRecentFiles(!!integrations?.microsoft);

  function importMicrosoft(ids: string[]) {
    importSources.mutate({ chapterId, fileIds: ids, provider: 'microsoft' });
    onClose();
  }

  //  TODO: i18n, select chapters
  return (
    <SimpleDialog onClose={onClose} open={open} title="OneDrive files">
      <div className="flex max-h-64 flex-col gap-1 overflow-auto">
        {(msFiles ?? []).map((f) => (
          <button
            className="rounded-row px-3 py-2 text-left text-sm hover:bg-surface-hover-bg"
            key={f.id}
            onClick={() => importMicrosoft([f.id])}
            type="button"
          >
            {f.name}
          </button>
        ))}
        {!msFiles?.length && (
          <p className="t-meta text-fg-muted">No recent files found.</p>
        )}
      </div>
    </SimpleDialog>
  );
}
