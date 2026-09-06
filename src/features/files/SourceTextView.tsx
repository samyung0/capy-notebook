import { type ReactNode, useEffect, useState } from 'react';
import type { SourceFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { SourceTextEditor } from './SourceTextEditor';
import { useSourceSession } from './useSourceSession';

export function SourceTextView({
  file,
  canEdit,
  onDirtyChange,
  renderPreview,
}: {
  file: SourceFile;
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
      <div className="flex min-h-10 items-center justify-end gap-2 border-line border-b px-2">
        {editing ? (
          <>
            <span className="t-meta mr-auto text-fg-muted">
              {source.handoff
                ? m.source_edit_handoff()
                : source.status === 'saved'
                  ? m.editor_status_saved()
                  : source.status === 'saving'
                    ? m.files_office_saving()
                    : source.status === 'offline'
                      ? m.source_edit_offline()
                      : ''}
            </span>
            <Button
              disabled={source.handoff}
              onClick={() => {
                void source.save().catch(() => {});
              }}
              size="sm"
            >
              {m.action_save()}
            </Button>
            <Button
              disabled={leaving || source.handoff}
              onClick={() => {
                void done().catch(() => {});
              }}
              size="sm"
            >
              {m.source_edit_done()}
            </Button>
          </>
        ) : (
          canEdit && (
            <Button
              onClick={() => {
                setJoined(true);
                setEditing(true);
              }}
              size="sm"
            >
              {m.source_edit_raw()}
            </Button>
          )
        )}
      </div>
      {source.error && (
        <p className="px-3 py-2 text-tint-error-fg">
          {source.error}
          {source.doc && (
            <Button onClick={downloadDraft} size="sm" variant="ghost-hover">
              {m.source_edit_download_draft()}
            </Button>
          )}
          {source.status === 'recovery' && (
            <Button
              disabled={source.discarding}
              onClick={() => {
                void source.discardDraft();
              }}
              size="sm"
              variant="ghost-hover"
            >
              {m.source_edit_discard_draft()}
            </Button>
          )}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {editing ? (
          source.doc ? (
            <SourceTextEditor
              doc={source.doc}
              onPendingChange={source.pendingInput}
              onSave={source.save}
              paused={
                !canEdit || source.handoff || source.status === 'recovery'
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
