import type { SourceFile } from '@/api/types';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { FileError, FileUnavailable, SourceBanners } from './FileStates';
import { useReportEditorStatus } from './fileModeContext';
import { OfficeHeader } from './OfficeMenuBar';
import type { OfficeCitation } from './officeProtocol';
import { type OfficeSwap, useOfficeRuntime } from './useOfficeRuntime';
import { sourceHeaderStatus } from './useSourceSession';

export default function DocxView({
  canEdit,
  citation,
  file,
  startEditing = false,
  swap,
}: {
  canEdit: boolean;
  citation?: OfficeCitation;
  file: SourceFile;
  startEditing?: boolean;
  swap?: OfficeSwap;
}) {
  const runtime = useOfficeRuntime({
    canEdit,
    citation,
    file,
    format: 'docx',
    initialMode: startEditing ? 'edit' : 'view',
    revision: file.revision,
    swap,
  });

  useReportEditorStatus(
    sourceHeaderStatus(runtime.status, {
      busy: runtime.saving || runtime.handoff,
      editing: runtime.mode === 'edit',
    }),
    runtime.slowed
  );

  if (runtime.unavailable)
    return <FileUnavailable kind={runtime.unavailable} />;

  if (runtime.error && !runtime.analysis && runtime.mode === 'view') {
    return (
      <FileError
        errorId={runtime.errorId}
        onRetry={runtime.retryView}
        title={m.files_docx_failed()}
      />
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
        ]}
        banner={runtime.banner}
        error={runtime.error}
        onReload={() => {
          void runtime.discardDraft();
        }}
        paused={runtime.paused}
        pausedAtOpen={runtime.pausedAtOpen}
        readOnly={runtime.readOnly}
        reloading={runtime.discarding}
        // A newer version swaps the view (OfficeFileView); only the
        // maintenance pause keeps its banner.
        replaced={runtime.replaced && runtime.paused}
        storageFull={runtime.storageFull}
      />
      <OfficeHeader
        canEdit={canEdit}
        label={
          runtime.ready
            ? runtime.mode === 'view' &&
              runtime.analysis?.format === 'docx' &&
              m.files_office_page_count({ count: runtime.analysis.pageCount })
            : m.files_office_opening_document()
        }
        runtime={runtime}
      />
      <div className="relative min-h-0 flex-1">
        {!runtime.analysis && runtime.mode === 'view' && (
          <Skeleton className="absolute inset-0 h-full w-full" />
        )}
        <iframe
          allow={runtime.iframeAllow}
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
