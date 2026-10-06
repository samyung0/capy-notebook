import { useEffect } from 'react';
import type { ViewableFile } from '@/api/types';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { FileError, FileUnavailable, SourceBanners } from './FileStates';
import { useReportEditorStatus } from './fileModeContext';
import { OfficeHeader } from './OfficeMenuBar';
import type { OfficeCitation } from './officeProtocol';
import { useOfficeRuntime } from './useOfficeRuntime';
import { sourceHeaderStatus } from './useSourceSession';

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

  useReportEditorStatus(
    sourceHeaderStatus(runtime.status, {
      busy: runtime.saving || runtime.handoff,
      editing: runtime.mode === 'edit',
    })
  );

  if (runtime.unavailable)
    return <FileUnavailable kind={runtime.unavailable} />;

  if (runtime.error && !runtime.analysis && runtime.mode === 'view') {
    return (
      <FileError onRetry={runtime.retryView} title={m.files_pptx_failed()} />
    );
  }
  // The runtime ticks View › Show speaker notes while the notes box is open;
  // WorkspaceOpen lifts its floating tools button above the box then.
  const notesOpen = runtime.menus?.menus
    .find((menu) => menu.id === 'view')
    ?.items.some(
      (entry) =>
        entry.kind === 'item' &&
        entry.id === 'view.speakerNotes' &&
        entry.checked
    );
  return (
    <div
      className="flex h-full min-h-[60vh] flex-col"
      data-office-notes-open={notesOpen || undefined}
    >
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
        replaced={runtime.replaced}
      />
      <OfficeHeader
        canEdit={canEdit}
        label={
          runtime.ready
            ? runtime.mode === 'view' &&
              runtime.analysis?.format === 'pptx' &&
              m.files_office_slide_count({
                count: runtime.analysis.slideCount,
              })
            : m.files_office_opening_presentation()
        }
        runtime={runtime}
      />
      {/* A show the browser did not put in full screen still gets the page. */}
      <div
        className={cn(
          'relative min-h-0 flex-1',
          runtime.presenting && 'fixed inset-0 z-[2147483000]'
        )}
      >
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
          title={m.files_office_presentation_frame_title({ name: file.name })}
        />
      </div>
    </div>
  );
}
