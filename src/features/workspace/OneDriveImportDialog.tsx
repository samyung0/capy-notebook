import { useState } from 'react';
import {
  useImportSources,
  useIntegrations,
  useMicrosoftRecentFiles,
} from '@/api/hooks';
import { SimpleDialog } from '@/components/ui/Dialog';
import { m } from '@/i18n';

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
  const { mutate: importSources } = useImportSources(workspaceId);
  const { data: integrations } = useIntegrations({ errorBoundary: false });
  const { data: msFiles } = useMicrosoftRecentFiles(!!integrations?.microsoft, {
    errorBoundary: false,
  });

  function importMicrosoft(ids: string[]) {
    importSources({ chapterId, fileIds: ids, provider: 'microsoft' });
    onClose();
  }

  // TODO: select chapters
  return (
    <SimpleDialog onClose={onClose} open={open} title={m.onedrive_title()}>
      <div className="flex max-h-64 flex-col gap-1 overflow-auto">
        {(msFiles ?? []).map((f) => (
          <button
            className="rounded-button px-3 py-2 text-left text-sm hover:bg-surface-hover-bg"
            key={f.id}
            onClick={() => importMicrosoft([f.id])}
            type="button"
          >
            {f.name}
          </button>
        ))}
        {!msFiles?.length && (
          <p className="t-meta text-fg-muted">{m.onedrive_empty()}</p>
        )}
      </div>
    </SimpleDialog>
  );
}
