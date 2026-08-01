import { useState } from 'react';
import { useAllFiles } from '@/api/hooks';
import type { SourceFile } from '@/api/types';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { SimpleDialog } from '@/components/ui/Dialog';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { FileViewer } from '@/features/files/FileViewer';
import { m } from '@/i18n';

export default function Files() {
  const { data, isLoading } = useAllFiles();
  const [open, setOpen] = useState<SourceFile | null>(null);

  return (
    <PanelWithInvertedRadius>
      <PageHeader title={m.nav_files()} />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {isLoading ? (
          <SkeletonCardGrid cardHeight={72} count={6} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data?.map((f) => (
              <Card
                className="flex items-center gap-3 p-5.5"
                interactive
                key={f.id}
                onClick={() => setOpen(f)}
                radius="card-lg"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-card bg-surface-hover-bg text-fg-secondary">
                  <Icon name="files" size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="t-subtitle truncate">{f.name}</p>
                  <p className="t-meta text-fg-muted">
                    {(f.sizeKb / 1024).toFixed(1)} MB
                  </p>
                </div>
                <Badge size="sm">{f.kind}</Badge>
              </Card>
            ))}
          </div>
        )}
      </div>
      <SimpleDialog
        onClose={() => setOpen(null)}
        open={!!open}
        title={open?.name}
        width={760}
      >
        <div className="min-h-[50vh]">{open && <FileViewer file={open} />}</div>
      </SimpleDialog>
    </PanelWithInvertedRadius>
  );
}
