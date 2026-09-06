import { useEffect } from 'react';
import type { SourceFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { useOfficeRuntime } from './useOfficeRuntime';

export default function DocxView({
  canEdit,
  file,
  onDirtyChange,
  startEditing = false,
}: {
  canEdit: boolean;
  file: SourceFile;
  onDirtyChange?: (dirty: boolean) => void;
  startEditing?: boolean;
}) {
  const runtime = useOfficeRuntime({
    canEdit,
    file,
    format: 'docx',
    initialMode: startEditing ? 'edit' : 'view',
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

  if (runtime.error && !runtime.analysis && runtime.mode === 'view') {
    return (
      <p className="py-8 text-center text-tint-error-fg">
        {m.files_docx_failed()}
      </p>
    );
  }
  return (
    <div className="flex h-full min-h-[60vh] flex-col">
      <div className="flex min-h-10 items-center gap-2 border-line border-b px-2">
        <span className="t-meta flex-1 text-fg-muted">
          {runtime.analysis?.format === 'docx'
            ? m.files_office_page_count({ count: runtime.analysis.pageCount })
            : m.files_office_opening_document()}
        </span>
        {runtime.saving && (
          <span className="t-meta">{m.files_office_saving()}</span>
        )}
        {canEdit && runtime.mode === 'view' && runtime.analysis && (
          <Button onClick={() => runtime.setRuntimeMode('edit')} size="sm">
            {m.action_edit()}
          </Button>
        )}
        {runtime.mode === 'edit' && (
          <>
            <span className="t-meta text-fg-muted">
              {runtime.status === 'saved'
                ? m.editor_status_saved()
                : runtime.handoff
                  ? m.source_edit_handoff()
                  : runtime.status === 'offline'
                    ? m.source_edit_offline()
                    : ''}
            </span>
            <Button
              disabled={!runtime.ready || runtime.handoff}
              onClick={() => {
                void runtime.save().catch(() => {});
              }}
              size="sm"
            >
              {m.action_save()}
            </Button>
          </>
        )}
        {runtime.mode === 'edit' && (
          <Button
            disabled={!runtime.ready || runtime.saving || runtime.handoff}
            onClick={() => {
              void runtime.setRuntimeMode('view');
            }}
            size="sm"
            variant="outline"
          >
            {m.source_edit_done()}
          </Button>
        )}
      </div>
      {runtime.error && (
        <p className="border-line border-b px-3 py-2 text-sm text-tint-error-fg">
          {runtime.error}
          {runtime.mode === 'edit' && (
            <Button
              onClick={() => {
                void runtime.downloadDraft().catch(() => {});
              }}
              size="sm"
              variant="ghost-hover"
            >
              {m.source_edit_download_draft()}
            </Button>
          )}
          {runtime.status === 'recovery' && (
            <Button
              disabled={runtime.discarding}
              onClick={() => {
                void runtime.discardDraft();
              }}
              size="sm"
              variant="ghost-hover"
            >
              {m.source_edit_discard_draft()}
            </Button>
          )}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        {!runtime.analysis && runtime.mode === 'view' && (
          <Skeleton className="absolute inset-0 h-full w-full" />
        )}
        <iframe
          className="h-full w-full border-0"
          key={runtime.iframeKey}
          ref={runtime.iframeRef}
          sandbox={runtime.iframeSandbox}
          src={runtime.iframeUrl}
          title={m.files_office_document_frame_title({ name: file.name })}
        />
      </div>
    </div>
  );
}
