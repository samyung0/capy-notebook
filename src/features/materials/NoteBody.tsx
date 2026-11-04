import {
  type ComponentProps,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as Y from 'yjs';
import type { Material } from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { SaveBanner } from '@/components/banners/SaveBanner';
import { Skeleton } from '@/components/ui/feedback';
import { FloatingBarContext } from '@/components/ui/floatingBarContext';
import {
  type CopyLabel,
  copyLabel,
  keepsCopyOf,
  type RoomSeed,
} from '@/features/collaboration/deviceCopy';
import { NoteSeat, NoteSeatContext } from '@/features/collaboration/noteSeat';
import type { PresenceConnection } from '@/features/collaboration/presence';
import type { ReadOnlyCode } from '@/features/notes/collaborationEvents';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { NoteBlocks } from '@/features/notes/liveNoteBlocks';
import { NoteDisplayToggles } from '@/features/notes/NoteDisplayToggles';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import {
  type NotePosition,
  type NoteView,
  restoreNotePosition,
} from '@/features/notes/roomSwap';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  type MaterialDocument,
  type MaterialValue,
  parseMaterialDocument,
} from './document';
import { EmbedLoading, EmbedViewContext } from './embeds/EmbedView';
import { MaterialAttributionFooter } from './MaterialAttributionFooter';
import { showNoteCitation } from './noteCitation';
import { paintedPosition } from './notePaintPlace';
import type { NoteCitationTarget } from './openItem';
import { embedKey, useNoteFooter } from './useNoteFooter';

/* Interactive Plate is the heaviest chunk in this route: it loads behind a
 * painted note, never before one. */
const NoteEditor = lazy(() =>
  import('@/features/notes/NoteEditor').then((module) => ({
    default: module.NoteEditor,
  }))
);

/* Static Plate preview is still heavy: kept out of the PDF and media path. */
let previewModule: typeof import('./MaterialPreview') | undefined;
export const loadPreview = () =>
  import('./MaterialPreview').then((module) => {
    previewModule = module;
    return module;
  });
const LazyMaterialPreview = lazy(() =>
  loadPreview().then((module) => ({ default: module.MaterialPreview }))
);

/** The skeleton where nothing is stored yet: no words (Epo 2026-11-04). */
export function NoteSkeleton() {
  return (
    <div
      aria-label={m.a11y_loading()}
      className="mx-auto flex w-full flex-col gap-2.5 px-5 pt-6 sm:px-10"
      role="status"
    >
      {[45, 100, 85, 92, 65].map((width) => (
        <Skeleton className="h-4" key={width} style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

const parsedDocuments = new WeakMap<MaterialDocument, MaterialValue>();

/** The projection as both the paint and the editor start from it, parsed once
 * per document: on a near-limit note the parse takes seconds in a dev build. */
export function parsedDocument(content: MaterialDocument): MaterialValue {
  let value = parsedDocuments.get(content);
  if (!value) {
    value = parseMaterialDocument(content)?.value ?? content.value;
    parsedDocuments.set(content, value);
  }
  return value;
}

const seedValues = new WeakMap<RoomSeed, MaterialValue>();

/** A note's value as its device copy holds it, read once. */
export function seedValue(seed: RoomSeed): MaterialValue {
  let value = seedValues.get(seed);
  if (!value) {
    value = new NoteBlocks(seed.doc.get('content', Y.XmlText)).handOver([]);
    seedValues.set(seed, value);
  }
  return value;
}

/** Shows a chat citation's passage in the note beside it. Each click brings
 * a new citation object, so a repeat scrolls and flashes again. */
function NoteCitation({ citation }: { citation: NoteCitationTarget }) {
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const scroller = anchor.current?.parentElement;
    return scroller ? showNoteCitation(scroller, citation) : undefined;
  }, [citation]);
  return <span hidden ref={anchor} />;
}

/** A material's credits after its document, in the reading column the static
 * renderer uses for it, so the paint and the editor (NoteEditorCore) end alike:
 * a note's own and those of the embeds its content holds (useNoteFooter). Like
 * every footer ending a view here, it keeps room under the workspace's floating
 * bar where that shows, and some space above the page's end. */
export function DocumentAttribution({ material }: { material: Material }) {
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  const overBar = useContext(FloatingBarContext);
  const embeds = useMemo(
    () => embedKey(material.content.value),
    [material.content]
  );
  const provenance = useNoteFooter(material, embeds);
  const { kind } = material;
  return (
    <MaterialAttributionFooter
      className={cn(
        'mx-auto w-full px-5 sm:px-10',
        overBar ? 'pb-28' : 'pb-12',
        (kind !== 'note' || displayWidth === 'half') && 'md:max-w-3xl'
      )}
      inline
      provenance={provenance}
    />
  );
}

/** What a painted note says about itself before its material read answers. */
type PaintLabel = Pick<CopyLabel, 'kind' | 'standalone' | 'title'>;

const labelOf = (
  material: Material | undefined,
  seed: RoomSeed | null | undefined
): PaintLabel | null =>
  material
    ? {
        kind: material.kind,
        standalone: !material.workspaceId,
        title: material.title,
      }
    : (seed?.row ?? null);

/** Embeds in a note about to become the editor: the editor's own join theirs,
 * so the paint holds their place and reads nothing. */
const HeldEmbed = () => <EmbedLoading />;

/** The editor's Tools toggle where it will be, so the row holds still. */
const HELD_TOOLBAR = {
  onToggle: () => undefined,
  shown: false,
};

function PaintedNote({
  label,
  material,
  value,
}: {
  label: PaintLabel;
  material: Material | undefined;
  value: MaterialValue;
}) {
  const [Preview] = useState(
    () => previewModule?.MaterialPreview ?? LazyMaterialPreview
  );
  const content = useMemo<MaterialDocument>(
    () => material?.content ?? { schemaVersion: 1, value },
    [material?.content, value]
  );
  return (
    <Preview
      content={content}
      isStandalone={label.standalone}
      kind={label.kind}
      title={label.title}
      value={value}
    />
  );
}

/**
 * A note in the one way it opens (Epo 2026-11-04): painted at once from the
 * device copy or the stored projection, static and read-only, while an editor's
 * Plate builds hidden behind it (read-only until the room's first sync) and
 * takes over silently at the same block and caret. A viewer's stays the paint,
 * following its room on a read channel.
 */
export function NoteBody({
  allowExternalAssets,
  citation,
  editing,
  material,
  materialId,
  onEditorStatusChange,
  onPresenceChange,
  onReadOnly,
  owner,
  seed,
  staticNote,
}: {
  allowExternalAssets: boolean;
  citation?: NoteCitationTarget;
  /** This person may edit it: Plate builds behind the paint. */
  editing: boolean;
  /** Undefined until its read answers, when a device copy paints alone. */
  material: Material | undefined;
  materialId: string;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
  onPresenceChange?: (connections: PresenceConnection[] | null) => void;
  onReadOnly: (code?: ReadOnlyCode) => void;
  owner: string | null | undefined;
  /** Its device copy: undefined until the read settled. */
  seed: RoomSeed | null | undefined;
  /** A heavy note opened read-only: paints the projection, joins no room. */
  staticNote: boolean;
}) {
  // One reader of the seed's document: the first path that opens the room.
  // A later one (an editor dropped to read-only) starts from the material.
  const handed = useRef<'editor' | 'reader' | null>(null);
  const path = editing && material ? 'editor' : 'reader';
  const usable = !handed.current || handed.current === path ? seed : null;
  const label = labelOf(material, usable);
  const painted = useMemo(
    () =>
      usable && !staticNote
        ? seedValue(usable)
        : material
          ? parsedDocument(material.content)
          : null,
    [material, staticNote, usable]
  );
  if (!(painted && label)) return <NoteSkeleton />;
  if (editing && material) {
    handed.current ??= 'editor';
    return (
      <EditingNote
        allowExternalAssets={allowExternalAssets}
        citation={citation}
        key={materialId}
        label={label}
        material={material}
        onEditorStatusChange={onEditorStatusChange}
        onPresenceChange={onPresenceChange}
        onReadOnly={onReadOnly}
        painted={painted}
        seed={usable}
      />
    );
  }
  if (material && !staticNote && seed !== undefined)
    handed.current ??= 'reader';
  return (
    <div className="relative h-full min-h-0 overflow-auto">
      <NoteDisplayToggles />
      {citation && <NoteCitation citation={citation} />}
      <Suspense fallback={<NoteSkeleton />}>
        {material && !staticNote && seed !== undefined ? (
          <LiveNote
            keep={
              owner && keepsCopyOf(material)
                ? copyLabel(material, owner)
                : undefined
            }
            label={label}
            material={material}
            painted={painted}
            seed={usable}
          />
        ) : (
          <PaintedNote label={label} material={material} value={painted} />
        )}
        {material && <DocumentAttribution material={material} />}
      </Suspense>
    </div>
  );
}

/** A reader's note: the paint, then its room's value block by block, keeping
 * each block the room has not changed, so nothing flashes and a remote
 * keystroke redraws one block. The live-read module loads outside the first
 * paint and every other bundle. */
function LiveNote({
  keep,
  label,
  material,
  painted,
  seed,
}: {
  keep?: CopyLabel;
  label: PaintLabel;
  material: Material;
  painted: MaterialValue;
  seed: RoomSeed | null | undefined;
}) {
  const [live, setLive] = useState<MaterialValue | null>(null);
  const first = useRef(painted);
  first.current = painted;
  const start = useRef({ keep, seed });
  // The note's read channel, inside which its embeds join (Epo 2026-10-20).
  const [seat] = useState(() => new NoteSeat());
  useEffect(() => {
    setLive(null);
    let leave: (() => void) | undefined;
    let gone = false;
    const timer = setTimeout(() => {
      void import('@/features/notes/liveNoteRead').then(({ readNoteLive }) => {
        if (!gone)
          leave = readNoteLive(material.id, first.current, setLive, {
            keep: start.current.keep,
            seat,
            seed: start.current.seed,
          });
      });
    });
    return () => {
      gone = true;
      clearTimeout(timer);
      leave?.();
    };
  }, [material.id, seat]);
  return (
    <NoteSeatContext.Provider value={seat}>
      <PaintedNote label={label} material={material} value={live ?? painted} />
    </NoteSeatContext.Provider>
  );
}

/** An editor's note: the paint on top until Plate behind it has painted the
 * room's document (or its saved copy, past the join's 30 s), then Plate, at the
 * reader's block and caret. At 30 s a strip with Retry shows over whichever is
 * on screen. */
function EditingNote({
  allowExternalAssets,
  citation,
  label,
  material,
  onEditorStatusChange,
  onPresenceChange,
  onReadOnly,
  painted,
  seed,
}: {
  allowExternalAssets: boolean;
  citation?: NoteCitationTarget;
  label: PaintLabel;
  material: Material;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
  onPresenceChange?: (connections: PresenceConnection[] | null) => void;
  onReadOnly: (code?: ReadOnlyCode) => void;
  painted: MaterialValue;
  seed: RoomSeed | null | undefined;
}) {
  const [shown, setShown] = useState(false);
  const paintBox = useRef<HTMLDivElement>(null);
  const moved = useRef<{ place: NotePosition; view: NoteView } | null>(null);
  const [editor, setEditor] = useState<NoteView | null>(null);
  const value = useRef(painted);
  const onShown = useCallback((view: NoteView | null) => {
    const box = paintBox.current;
    const place = box && view && paintedPosition(box, value.current);
    if (place && view) moved.current = { place, view };
    setEditor(view);
    setShown(true);
  }, []);
  // The editor is laid out behind the paint, and on screen from this commit:
  // back where the reader was before the browser paints it.
  useLayoutEffect(() => {
    if (!(shown && moved.current)) return;
    restoreNotePosition(moved.current.view, moved.current.place);
    moved.current = null;
  }, [shown]);
  // A chat citation's passage, in the editor once it shows (in the paint until
  // then): each click brings a new citation object.
  useEffect(
    () =>
      shown && editor && citation
        ? showNoteCitation(editor.scrollArea, citation)
        : undefined,
    [citation, editor, shown]
  );
  const [joinFailed, setJoinFailed] = useState<{ retry: () => void } | null>(
    null
  );
  const onJoinFailed = useCallback(
    (retry: (() => void) | null) => setJoinFailed(retry && { retry }),
    []
  );
  return (
    <AppErrorBoundary resetKeys={[material.id]}>
      <div className="flex h-full min-h-0 flex-col">
        {joinFailed && (
          <SaveBanner onRetry={joinFailed.retry} state="unreachable" />
        )}
        <div className="relative min-h-0 flex-1">
          {!shown && (
            <div
              className="relative h-full min-h-0 overflow-auto"
              data-note-paint=""
              ref={paintBox}
            >
              <NoteDisplayToggles toolbar={HELD_TOOLBAR} />
              {citation && <NoteCitation citation={citation} />}
              <EmbedViewContext.Provider value={HeldEmbed}>
                <Suspense fallback={<NoteSkeleton />}>
                  <PaintedNote
                    label={label}
                    material={material}
                    value={painted}
                  />
                  <DocumentAttribution material={material} />
                </Suspense>
              </EmbedViewContext.Provider>
            </div>
          )}
          <div
            className={cn('h-full', !shown && 'invisible absolute inset-0')}
            inert={!shown}
          >
            <Suspense fallback={null}>
              <NoteEditor
                allowExternalAssets={allowExternalAssets}
                materialId={material.id}
                onEditorStatusChange={onEditorStatusChange}
                onJoinFailed={onJoinFailed}
                onPresenceChange={onPresenceChange}
                onReadOnly={onReadOnly}
                onShown={onShown}
                seed={seed}
              />
            </Suspense>
          </div>
        </div>
      </div>
    </AppErrorBoundary>
  );
}

export type NoteBodyProps = ComponentProps<typeof NoteBody>;
