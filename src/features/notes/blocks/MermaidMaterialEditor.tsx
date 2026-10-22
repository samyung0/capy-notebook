import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { qk } from '@/api/client';
import { useMe } from '@/api/hooks';
import type { Material, Provenance } from '@/api/types';
import { isOutdatedBanner, SaveBanner } from '@/components/banners/SaveBanner';
import { Icon } from '@/components/ui/Icon';
import { CharCount } from '@/components/ui/Input';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { CollaborationHold } from '@/features/collaboration/CollaborationHold';
import {
  itemEditingStopped,
  useItemRoom,
} from '@/features/collaboration/itemRoom';
import {
  itemSaveState,
  UndoButtons,
} from '@/features/collaboration/LiveItemControls';
import {
  type PresenceConnection,
  useReportPresence,
} from '@/features/collaboration/presence';
import type { UndoTarget } from '@/features/collaboration/undo';
import {
  LOCAL_EDIT,
  useBoundText,
  useYText,
} from '@/features/collaboration/yText';
import { FileLoading } from '@/features/files/FileStates';
import {
  BLOCK_CAPTION_MAX,
  type MaterialDocument,
  MERMAID_SOURCE_MAX,
} from '@/features/materials/document';
import {
  blockSource,
  type LiveMermaid,
  mermaidNode,
  readMermaid,
  useMermaid,
  withMermaid,
} from '@/features/materials/liveMermaid';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { MediaFrame } from '@/features/materials/MediaFrame';
import { MermaidPreview } from '@/features/materials/MediaPreview';
import {
  MERMAID_TYPING_DELAY_MS,
  Mermaid,
  mermaidFailureMessage,
} from '@/features/materials/Mermaid';
import { MermaidCodeEditor } from '@/features/materials/MermaidCodeEditor';
import { MermaidMaterialView } from '@/features/materials/MermaidMaterialView';
import { MermaidThemeSelect } from '@/features/materials/MermaidThemeSelect';
import type { MermaidFailure } from '@/features/materials/mermaidError';
import {
  type MermaidTheme,
  mermaidTheme,
} from '@/features/materials/mermaidThemes';
import type { ReadOnlyCode } from '@/features/notes/collaborationEvents';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { registerLiveNote } from '@/features/notes/liveNoteHandover';
import { MERMAID_CAPTION_CLASS } from '@/features/notes/nodeStyles';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';

/**
 * Edit mode of a standalone mindmap or diagram, without Plate (Epo
 * 2026-10-09, live since 2026-10-10): it joins the material's room and edits
 * its one block there as it is typed. The source (a Y.Text, shape A) is in
 * CodeMirror, the caption and theme in place; there is no Save or Cancel,
 * Undo and Redo take back this user's own edits, and the room state goes to
 * the header's save status. Unsent edits stay on this device as a set's do.
 */
export default function MermaidMaterialEditor({
  kind,
  materialId,
  onPresenceChange,
  onReadOnly,
  onStatusChange,
  provenance,
  title,
}: {
  kind: 'mindmap' | 'diagram';
  materialId: string;
  provenance: Provenance | undefined;
  /** The room turned read-only (`code`: why, when it says): the caller
   * drops to View. */
  onReadOnly: (code?: ReadOnlyCode) => void;
  onStatusChange: (status: NoteEditorStatus | null) => void;
  /** The room's other editors, for the header's avatar group. */
  onPresenceChange?: (connections: PresenceConnection[] | null) => void;
  title: string;
}) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const actorId = me?.id ?? null;
  const { room, snapshot } = useItemRoom(materialId, !!actorId, { actorId });
  const live = useMermaid(room?.doc);
  const recovered = useMermaid(snapshot.recovery?.doc);
  useEffect(() => {
    const saveState = snapshot.recovery
      ? 'error'
      : itemSaveState(snapshot.status, snapshot.offline);
    onStatusChange(saveState ? { saveState } : null);
  }, [snapshot.status, snapshot.recovery, snapshot.offline, onStatusChange]);
  useEffect(() => () => onStatusChange(null), [onStatusChange]);
  useReportPresence(onPresenceChange, snapshot.presence);
  useEffect(() => {
    if (snapshot.access === 'read')
      onReadOnly(snapshot.readOnlyCode ?? undefined);
  }, [snapshot.access, snapshot.readOnlyCode, onReadOnly]);
  // Edit to View: the live block goes into the cached material first.
  useEffect(() => {
    if (!room) return;
    return registerLiveNote(materialId, () => {
      const current = readMermaid(room.doc);
      if (!(current && room.getSnapshot().synced)) return;
      qc.setQueryData<Material>(
        qk.material(materialId),
        (cached) =>
          cached && {
            ...cached,
            content: withMermaid(cached.content, current),
          }
      );
    });
  }, [room, materialId, qc]);

  if (snapshot.status === 'unavailable')
    return (
      <p className="t-meta p-6 text-fg-muted">{m.material_ref_unavailable()}</p>
    );
  if (room && snapshot.recovery)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <SaveBanner
          onReload={() => void room.reload()}
          state={snapshot.recovery.refused ? 'refused' : 'changed'}
        />
        {recovered && (
          <ReadOnlyDiagram kind={kind} live={recovered} title={title} />
        )}
      </div>
    );
  // Refused as outdated before it synced: nothing of the room to show.
  if (isOutdatedBanner(snapshot.offline) && !snapshot.synced)
    return <SaveBanner state="outdated" />;
  if (!(room && snapshot.synced && live))
    return (
      <FileLoading message={m.editor_connecting()} slowed={snapshot.slowed} />
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {snapshot.offline && <SaveBanner state={snapshot.offline} />}
      <CollaborationHold className="flex min-h-0 flex-1 flex-col">
        <LiveDiagram
          history={room.history}
          live={live}
          provenance={provenance}
          readOnly={itemEditingStopped(snapshot.offline)}
          title={title}
        />
      </CollaborationHold>
    </div>
  );
}

function ReadOnlyDiagram({
  kind,
  live,
  title,
}: {
  kind: 'mindmap' | 'diagram';
  live: LiveMermaid;
  title: string;
}) {
  const content: MaterialDocument = {
    schemaVersion: 1,
    value: [mermaidNode(live)],
  } as MaterialDocument;
  return (
    <MermaidMaterialView
      content={content}
      material={{ isStandalone: true, kind, title }}
    />
  );
}

function LiveDiagram({
  history,
  live,
  provenance,
  readOnly,
  title,
}: {
  history: UndoTarget;
  live: LiveMermaid;
  provenance: Provenance | undefined;
  readOnly: boolean;
  title: string;
}) {
  const text = live.source instanceof Y.Text ? live.source : null;
  // A string the room still holds becomes a text once, outside Undo; the
  // block re-reads with it.
  useEffect(() => {
    if (!text) blockSource(live.block);
  }, [text, live]);
  const code = useYText(text);
  const caption = useBoundText<HTMLInputElement>(live.caption);
  const theme = mermaidTheme(live.theme);
  const [showPreview, setShowPreview] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [failure, setFailure] = useState<MermaidFailure | null>(null);
  // An edit past the source cap (MERMAID_SOURCE_MAX) was refused.
  const [tooLong, setTooLong] = useState(false);
  const [previewCode, setPreviewCode] = useState(code);
  // The full-screen view shows the last source that drew; none drew yet
  // (a broken diagram opened in Edit), nothing opens.
  const [drawnCode, setDrawnCode] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(
      () => setPreviewCode(code),
      MERMAID_TYPING_DELAY_MS
    );
    return () => clearTimeout(timer);
  }, [code]);
  const shown: MermaidFailure | null = tooLong
    ? { line: null, reason: 'tooLong' }
    : failure;
  const message =
    shown && shown.line == null ? mermaidFailureMessage(shown) : null;
  const setTheme = (next: MermaidTheme) =>
    live.block.doc?.transact(
      () => live.block.setAttribute('theme', next),
      LOCAL_EDIT
    );
  if (!text) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" inert={readOnly}>
      <div className="flex min-h-12 items-center gap-2 border-divider border-b px-4 py-2">
        <MermaidThemeSelect onTheme={setTheme} theme={theme} />
        <ToolbarButton
          active={showPreview}
          className="w-auto! gap-1.5 px-2 text-sm md:hidden"
          label={showPreview ? m.mermaid_show_code() : m.mermaid_show_preview()}
          onClick={() => setShowPreview((value) => !value)}
        >
          <Icon name={showPreview ? 'code' : 'view'} />
          <span className="translate-y-px">
            {showPreview ? m.mermaid_show_code() : m.mermaid_show_preview()}
          </span>
        </ToolbarButton>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {/* A blamed line is marked in the source instead. */}
          {message && (
            <p className="min-w-0 truncate font-semibold text-sm text-solid-error">
              {message}
            </p>
          )}
          <UndoButtons manager={history} />
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] md:grid-cols-2">
        <MermaidCodeEditor
          className={cn(
            'overflow-auto md:block md:border-divider md:border-r',
            showPreview && 'hidden'
          )}
          errorLine={failure?.line ?? null}
          history={history}
          label={m.editor_mermaid_source()}
          maxLength={MERMAID_SOURCE_MAX}
          onChange={() => setTooLong(false)}
          onRefused={() => setTooLong(true)}
          origin={LOCAL_EDIT}
          text={text}
          value={code}
        />
        <div
          className={cn(
            'min-h-0 flex-col gap-3 overflow-auto px-4 py-5 md:flex md:px-6',
            showPreview ? 'flex' : 'hidden'
          )}
        >
          <MediaFrame
            fill
            onOpen={drawnCode === null ? undefined : () => setPreviewing(true)}
          >
            <Mermaid
              code={previewCode}
              onError={(next) => {
                setFailure(next);
                if (!next) setDrawnCode(previewCode);
              }}
              theme={theme}
            />
          </MediaFrame>
          {live.caption && (
            <div className="flex items-baseline gap-2">
              <input
                aria-label={m.editor_caption_add()}
                className={cn(
                  MERMAID_CAPTION_CLASS,
                  'mt-0 block min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder'
                )}
                maxLength={BLOCK_CAPTION_MAX}
                onChange={caption.onChange}
                placeholder={m.editor_caption_placeholder()}
                ref={caption.ref}
                value={caption.value}
              />
              <CharCount
                className="shrink-0"
                max={BLOCK_CAPTION_MAX}
                value={textLength(caption.value)}
              />
            </div>
          )}
          <MaterialAttributionFooter inline provenance={provenance} />
        </div>
      </div>
      <MermaidPreview
        caption={caption.value}
        code={drawnCode ?? ''}
        onOpenChange={setPreviewing}
        open={previewing}
        theme={theme}
        title={title}
      />
    </div>
  );
}
