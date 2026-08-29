import type { SourceFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { useOfficeRuntime } from './useOfficeRuntime';

export default function PptxView({
  canEdit,
  file,
  onSave,
}: {
  canEdit: boolean;
  file: SourceFile;
  onSave?: (
    bytes: Uint8Array,
    expectedRevision: number
  ) => Promise<{
    revision: number;
  }>;
}) {
  const runtime = useOfficeRuntime({
    canEdit,
    file,
    format: 'pptx',
    onSave,
    revision: file.revision,
  });

  if (runtime.error && !runtime.analysis) {
    return (
      <p className="py-8 text-center text-tint-error-fg">
        {m.files_pptx_failed()}
      </p>
    );
  }
  return (
    <div className="flex h-full min-h-[60vh] flex-col">
      <div className="flex min-h-10 items-center gap-2 border-line border-b px-2">
        <span className="t-meta flex-1 text-fg-muted">
          {runtime.analysis?.format === 'pptx'
            ? m.files_office_slide_count({ count: runtime.analysis.slideCount })
            : m.files_office_opening_presentation()}
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
              )
                runtime.setRuntimeMode('view');
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
        {!runtime.analysis && (
          <Skeleton className="absolute inset-0 h-full w-full" />
        )}
        <iframe
          className="h-full w-full border-0"
          onLoad={() => runtime.setFrameLoaded(true)}
          ref={runtime.iframeRef}
          sandbox="allow-downloads allow-same-origin allow-scripts"
          src="/office-runtime.html"
          title={m.files_office_presentation_frame_title({ name: file.name })}
        />
      </div>
    </div>
  );
}
