import { useEffect } from 'react';
import type { SourceFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { useOfficeRuntime } from './useOfficeRuntime';

export default function SheetView({
  canEdit,
  file,
  onCancelEditing,
  onDirtyChange,
  onSave,
  startEditing = false,
}: {
  canEdit: boolean;
  file: SourceFile;
  onCancelEditing?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSave?: (
    bytes: Uint8Array,
    expectedRevision: number
  ) => Promise<{
    revision: number;
  }>;
  startEditing?: boolean;
}) {
  const runtime = useOfficeRuntime({
    canEdit,
    file,
    format: 'xlsx',
    initialMode: startEditing ? 'edit' : 'view',
    onSave,
    revision: file.revision,
  });

  useEffect(() => {
    onDirtyChange?.(runtime.dirty);
  }, [onDirtyChange, runtime.dirty]);

  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange]
  );

  if (runtime.error && !runtime.analysis) {
    return (
      <p className="py-8 text-center text-tint-error-fg">
        {m.files_sheet_failed()}
      </p>
    );
  }
  return (
    <div className="flex h-full min-h-[60vh] flex-col">
      <div className="flex min-h-10 items-center gap-2 border-line border-b px-2">
        <span className="t-meta flex-1 text-fg-muted">
          {runtime.analysis?.format === 'xlsx'
            ? m.files_office_sheet_count({
                count: runtime.analysis.sheetCount,
              })
            : m.files_office_opening_workbook()}
        </span>
        {runtime.saving && (
          <span className="t-meta">{m.files_office_saving()}</span>
        )}
        {canEdit &&
          file.status === 'ready' &&
          onSave &&
          runtime.mode === 'view' &&
          runtime.analysis && (
            <Button onClick={() => runtime.setRuntimeMode('edit')} size="sm">
              {m.action_edit()}
            </Button>
          )}
        {runtime.mode === 'edit' && (
          <Button
            onClick={() => {
              if (
                !runtime.dirty ||
                window.confirm(m.files_office_discard_changes())
              ) {
                if (onCancelEditing) onCancelEditing();
                else runtime.setRuntimeMode('view');
              }
            }}
            size="sm"
            variant="outline"
          >
            {m.files_office_cancel_editing()}
          </Button>
        )}
      </div>
      {runtime.error && runtime.analysis && (
        <p className="border-line border-b px-3 py-2 text-sm text-tint-error-fg">
          {runtime.error}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        {!runtime.analysis && runtime.mode === 'view' && (
          <Skeleton className="absolute inset-0 h-full w-full" />
        )}
        <iframe
          className="h-full w-full border-0"
          key={runtime.iframeKey}
          onLoad={() => runtime.setFrameLoaded(true)}
          ref={runtime.iframeRef}
          sandbox={runtime.iframeSandbox}
          src={runtime.iframeUrl}
          title={m.files_office_workbook_frame_title({ name: file.name })}
        />
      </div>
    </div>
  );
}
