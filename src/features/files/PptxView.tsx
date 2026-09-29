import { useEffect } from 'react';
import type { ViewableFile } from '@/api/types';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { FileModeControl } from './FileModeControl';
import { FileError, SourceBanners } from './FileStates';
import type { OfficeCitation } from './officeProtocol';
import { useOfficeRuntime } from './useOfficeRuntime';

export default function PptxView({
  canEdit,
  citation,
  file,
  onDirtyChange,
  startEditing = false,
}: {
  canEdit: boolean;
  citation?: OfficeCitation;
  file: ViewableFile;
  onDirtyChange?: (dirty: boolean) => void;
  startEditing?: boolean;
}) {
  const runtime = useOfficeRuntime({
    canEdit,
    citation,
    file,
    format: 'pptx',
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
      <FileError onRetry={runtime.retryView} title={m.files_pptx_failed()} />
    );
  }
  return (
    <div className="flex h-full min-h-[60vh] flex-col">
      <SourceBanners
        actions={[
          ...(runtime.mode === 'view'
            ? [{ label: m.error_action_retry(), onClick: runtime.retryView }]
            : [
                {
                  label: m.source_edit_download_draft(),
                  onClick: () => {
                    void runtime.downloadDraft().catch(() => {});
                  },
                },
              ]),
          ...(runtime.status === 'recovery'
            ? [
                {
                  disabled: runtime.discarding,
                  label: m.source_edit_discard_draft(),
                  onClick: () => {
                    void runtime.discardDraft();
                  },
                },
              ]
            : []),
        ]}
        error={runtime.error}
        paused={runtime.paused}
        pausedAtOpen={runtime.pausedAtOpen}
        readOnly={runtime.readOnly}
        replaced={runtime.replaced}
      />
      <div className="flex min-h-10 items-center gap-2 border-line border-b px-2">
        <span className="t-meta flex-1 text-fg-muted">
          {runtime.analysis?.format === 'pptx'
            ? m.files_office_slide_count({ count: runtime.analysis.slideCount })
            : m.files_office_opening_presentation()}
        </span>
        <FileModeControl
          canEdit={canEdit}
          disabled={
            runtime.mode === 'view'
              ? !runtime.analysis
              : !runtime.ready ||
                runtime.saving ||
                runtime.handoff ||
                runtime.replaced
          }
          mode={runtime.mode}
          onChange={runtime.setRuntimeMode}
          onSave={() => {
            void runtime.save().catch(() => {});
          }}
          saveDisabled={!runtime.ready || runtime.handoff || runtime.replaced}
          status={
            runtime.saving
              ? m.files_office_saving()
              : runtime.mode === 'edit'
                ? runtime.status === 'saved'
                  ? m.editor_status_saved()
                  : runtime.handoff
                    ? m.source_edit_handoff()
                    : runtime.status === 'offline'
                      ? m.source_edit_offline()
                      : undefined
                : undefined
          }
        />
      </div>
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
          title={m.files_office_presentation_frame_title({ name: file.name })}
        />
      </div>
    </div>
  );
}
