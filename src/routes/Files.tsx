import { useState } from 'react';
import { useAllFiles } from '@/api/hooks';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { SimpleDialog } from '@/components/ui/Dialog';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { FileNotIndexedBanner } from '@/features/files/FileStates';
import { FileViewer } from '@/features/files/FileViewer';
import { formatFileSize } from '@/features/files/fileUtils';
import { useOfficeEditGuard } from '@/features/files/useOfficeEditGuard';
import { m } from '@/i18n';

export default function Files() {
  const { data, fetchStatus, isLoading } = useAllFiles();
  const [openFileId, setOpenFileId] = useState<string | null>(null);
  const [officeEditDirty, setOfficeEditDirty] = useState(false);
  const confirmViewerReplacement = useOfficeEditGuard(officeEditDirty);
  const open = data?.find((file) => file.id === openFileId) ?? null;

  const openFile = (fileId: string) => {
    if (openFileId !== fileId && !confirmViewerReplacement()) return;
    setOfficeEditDirty(false);
    setOpenFileId(fileId);
  };

  const closeFile = () => {
    if (!confirmViewerReplacement()) return;
    setOfficeEditDirty(false);
    setOpenFileId(null);
  };

  return (
    <PanelWithInvertedRadius>
      <PageHeader title={m.nav_files()} />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {fetchStatus === 'paused' ? (
          <QueryPausedState />
        ) : isLoading ? (
          <SkeletonCardGrid cardHeight={72} count={6} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data?.map((f) => (
              <Card
                className="flex items-center gap-3 p-5.5"
                interactive
                key={f.id}
                onClick={() => openFile(f.id)}
                radius="card-lg"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-card bg-surface-hover-bg text-fg-secondary">
                  <Icon name="files" size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="t-subtitle truncate">{f.name}</p>
                  <p className="t-meta text-fg-muted">
                    {formatFileSize(f.sizeBytes)}
                  </p>
                </div>
                <Badge size="sm">{f.kind}</Badge>
              </Card>
            ))}
          </div>
        )}
      </div>
      <SimpleDialog
        onClose={closeFile}
        open={!!open}
        title={open?.name}
        width={760}
      >
        <div className="flex min-h-[50vh] flex-col">
          {open && <FileNotIndexedBanner file={open} />}
          <div className="min-h-0 flex-1">
            {open && (
              <FileViewer file={open} onDirtyChange={setOfficeEditDirty} />
            )}
          </div>
        </div>
      </SimpleDialog>
    </PanelWithInvertedRadius>
  );
}
