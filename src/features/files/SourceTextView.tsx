import { type ReactNode, useEffect, useState } from 'react';
import type { ViewableFile } from '@/api/types';
import { WarningBanner } from '@/components/banners/WarningBanner';
import { ErrorAction } from '@/components/ui/Button';
import { m } from '@/i18n';
import { FileModeControl } from './FileModeControl';
import { SourceReplacedBanner } from './FileStates';
import { SourceTextEditor } from './SourceTextEditor';
import { useSourceSession } from './useSourceSession';

export function SourceTextView({
  file,
  canEdit,
  onDirtyChange,
  renderPreview,
}: {
  file: ViewableFile;
  canEdit: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  renderPreview: (url: string | undefined) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [joined, setJoined] = useState(false);
  const [previewURL, setPreviewURL] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const source = useSourceSession(file.id, joined);
  useEffect(() => {
    onDirtyChange?.(source.dirty);
    return () => onDirtyChange?.(false);
  }, [source.dirty, onDirtyChange]);
  useEffect(() => {
    if (editing || !source.doc || source.status === 'recovery') return;
    const text = source.doc.getText('source');
    let current: string | undefined;
    const refresh = () => {
      if (current) URL.revokeObjectURL(current);
      current = URL.createObjectURL(
        new Blob([text.toString()], { type: 'text/plain;charset=utf-8' })
      );
      setPreviewURL(current);
    };
    refresh();
    text.observe(refresh);
    return () => {
      text.unobserve(refresh);
      if (current) URL.revokeObjectURL(current);
    };
  }, [editing, source.doc, source.status === 'recovery']);
  const downloadDraft = () => {
    if (!source.doc) return;
    const url = URL.createObjectURL(
      new Blob([source.doc.getText('source').toString()], {
        type: 'text/plain;charset=utf-8',
      })
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const done = async () => {
    setLeaving(true);
    try {
      await source.save();
      setEditing(false);
    } finally {
      setLeaving(false);
    }
  };
  return (
    <div className="flex h-full min-h-[60vh] flex-col">
      <FileModeControl
        canEdit={canEdit}
        disabled={leaving || source.handoff || source.replaced}
        mode={editing ? 'edit' : 'view'}
        onChange={(mode) => {
          if (mode === 'edit') {
            setJoined(true);
            setEditing(true);
          } else void done().catch(() => {});
        }}
        onSave={() => {
          void source.save().catch(() => {});
        }}
        saveDisabled={source.handoff || source.replaced}
        status={
          editing
            ? source.handoff
              ? m.source_edit_handoff()
              : source.status === 'saved'
                ? m.editor_status_saved()
                : source.status === 'saving'
                  ? m.files_office_saving()
                  : source.status === 'offline'
                    ? m.source_edit_offline()
                    : undefined
            : undefined
        }
      />
      {source.error && (
        <WarningBanner
          action={
            <>
              {source.doc && (
                <ErrorAction
                  iconLeft="download"
                  iconLeftClassName="me-1"
                  onClick={downloadDraft}
                  size="sm"
                >
                  {m.source_edit_download_draft()}
                </ErrorAction>
              )}
              {source.status === 'recovery' && (
                <ErrorAction
                  disabled={source.discarding}
                  iconLeft="trash"
                  iconLeftClassName="me-1"
                  onClick={() => {
                    void source.discardDraft();
                  }}
                  size="sm"
                >
                  {m.source_edit_discard_draft()}
                </ErrorAction>
              )}
            </>
          }
          icon="fileError"
          message={source.error}
        />
      )}
      {source.replaced && <SourceReplacedBanner paused={source.paused} />}
      <div className="min-h-0 flex-1 overflow-auto">
        {editing ? (
          source.doc ? (
            <SourceTextEditor
              doc={source.doc}
              onPendingChange={source.pendingInput}
              onSave={source.save}
              paused={
                !canEdit ||
                source.handoff ||
                source.replaced ||
                source.status === 'recovery'
              }
              registerFlush={source.flushHandler}
            />
          ) : (
            <p className="p-4">{m.common_loading()}</p>
          )
        ) : (
          renderPreview(previewURL)
        )}
      </div>
    </div>
  );
}
