import { type ReactNode, Suspense, useEffect, useState } from 'react';
import * as Y from 'yjs';
import { api } from '@/api/client';
import type { SourceSession, ViewableFile } from '@/api/types';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { FileModeControl, useFileMode } from './FileModeControl';
import {
  FileError,
  FileLoading,
  FileUnavailable,
  SourceBanners,
} from './FileStates';
import { useReportEditorStatus } from './fileModeContext';
import { SourceTextEditor } from './SourceTextEditor';
import {
  decodeSourceState,
  sourceHeaderStatus,
  useSourceSession,
} from './useSourceSession';

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
  const [mode, setMode] = useFileMode(canEdit, 'view');
  const editing = mode === 'edit';
  const [joined, setJoined] = useState(editing);
  const [previewURL, setPreviewURL] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  // The room turned read-only (a storage or frozen refusal): the session
  // discarded its unsaved edits, and the file drops to view mode.
  const source = useSourceSession(file.id, joined, () => {
    setJoined(false);
    setMode('view');
  });
  // The maintenance pause refused editing before the room opened.
  const pausedAtOpen = source.paused && !source.doc;
  useEffect(() => {
    if (!editing || !pausedAtOpen) return;
    setJoined(false);
    setMode('view');
  }, [editing, pausedAtOpen, setMode]);
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
      setPreviewURL(undefined);
    };
  }, [editing, source.doc, source.status === 'recovery']);
  // View mode without an open session (a fresh open, or the drop after a
  // storage or frozen refusal) shows the latest saved state, as Office does:
  // the view session carries it while a saved checkpoint is ahead of the
  // indexed one, and the published bytes are current otherwise.
  const [saved, setSaved] = useState<{ url?: string } | 'failed' | null>(null);
  const [savedAttempt, setSavedAttempt] = useState(0);
  useEffect(() => {
    if (editing || source.doc) return;
    let cancelled = false;
    let url: string | undefined;
    setSaved(null);
    api.get<SourceSession>(`/files/${file.id}/source-session?view=true`).then(
      (session) => {
        if (cancelled) return;
        if (session.state) {
          const doc = new Y.Doc();
          Y.applyUpdate(doc, decodeSourceState(session.state));
          url = URL.createObjectURL(
            new Blob([doc.getText('source').toString()], {
              type: 'text/plain;charset=utf-8',
            })
          );
          doc.destroy();
        }
        setSaved({ url });
      },
      () => {
        if (!cancelled) setSaved('failed');
      }
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [editing, source.doc, file.id, file.revision, savedAttempt]);
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
  useReportEditorStatus(
    sourceHeaderStatus(source.status, {
      busy: leaving || source.handoff,
      editing,
    })
  );
  const done = async () => {
    setLeaving(true);
    try {
      await source.save();
      setMode('view');
      return true;
    } catch {
      return false;
    } finally {
      setLeaving(false);
    }
  };
  // The preview is lazy: its own boundary keeps a first load from suspending
  // this view, which would disconnect the mode toggle it portals into the
  // header and drop a click on it.
  const preview = (url: string | undefined) => (
    <Suspense fallback={<FileLoading />}>{renderPreview(url)}</Suspense>
  );
  if (source.unavailable) return <FileUnavailable kind={source.unavailable} />;
  return (
    <div
      className="flex h-full min-h-[60vh] flex-col"
      data-source-status={source.status}
    >
      <FileModeControl
        canEdit={canEdit}
        disabled={leaving || source.handoff || source.replaced}
        mode={mode}
        onChange={(mode) => {
          if (mode === 'edit') {
            setJoined(true);
            setMode('edit');
          } else return done();
        }}
        onSave={() => {
          void source.save().catch(() => {});
        }}
        saveDisabled={source.handoff || source.replaced}
      />
      <SourceBanners
        actions={[
          ...(source.doc
            ? [
                {
                  label: m.source_edit_download_draft(),
                  onClick: downloadDraft,
                },
              ]
            : []),
        ]}
        banner={source.banner}
        error={source.error}
        onReload={() => {
          void source.discardDraft();
        }}
        paused={source.paused}
        pausedAtOpen={pausedAtOpen}
        readOnly={source.readOnly}
        reloading={source.discarding}
        replaced={source.replaced}
      />
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
                source.offlineLimit ||
                source.status === 'recovery'
              }
              registerFlush={source.flushHandler}
            />
          ) : (
            <div
              aria-label={m.a11y_loading()}
              className="flex flex-col gap-2.5 p-4"
              role="status"
            >
              {[75, 100, 85, 65, 80].map((width) => (
                <Skeleton
                  className="h-4"
                  key={width}
                  style={{ width: `${width}%` }}
                />
              ))}
            </div>
          )
        ) : source.doc ? (
          preview(previewURL)
        ) : saved === 'failed' ? (
          <FileError onRetry={() => setSavedAttempt((value) => value + 1)} />
        ) : saved ? (
          preview(saved.url)
        ) : (
          <FileLoading />
        )}
      </div>
    </div>
  );
}
