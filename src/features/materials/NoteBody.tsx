import { useQueryClient } from '@tanstack/react-query';
import type { PlateEditor } from 'platejs/react';
import {
  type ComponentProps,
  lazy,
  type RefObject,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import * as Y from 'yjs';
import { qk } from '@/api/client';
import { materialTokenQuery } from '@/api/hooks';
import type { Material } from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { SaveBanner } from '@/components/banners/SaveBanner';
import { Button } from '@/components/ui/Button';
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
import { FileActionsTarget } from '@/features/files/fileModeContext';
import type { ReadOnlyCode } from '@/features/notes/collaborationEvents';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { NoteBlocks } from '@/features/notes/liveNoteBlocks';
import { NoteDisplayToggles } from '@/features/notes/NoteDisplayToggles';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import {
  captureNotePosition,
  type NotePosition,
  type NoteView,
  restoreNotePosition,
} from '@/features/notes/roomSwap';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { forgetNoteCopy } from '@/lib/sourceCache';
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
const loadEditor = () => import('@/features/notes/NoteEditor');
const NoteEditor = lazy(() =>
  loadEditor().then((module) => ({ default: module.NoteEditor }))
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
export function DocumentAttribution({
  material,
  value = material.content.value,
}: {
  material: Material;
  /** What the note shows: a read without its body holds none. */
  value?: MaterialValue;
}) {
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  const overBar = useContext(FloatingBarContext);
  const embeds = useMemo(() => embedKey(value), [value]);
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
  // The same object while the body is not there: the static note stays put as
  // the read answers.
  const body =
    material && !material.contentOmitted ? material.content : undefined;
  const content = useMemo<MaterialDocument>(
    () => body ?? { schemaVersion: 1, value },
    [body, value]
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
        : material && !material.contentOmitted
          ? parsedDocument(material.content)
          : null,
    [material, staticNote, usable]
  );
  // Read without its body, and no copy to paint from after all: its body comes.
  const bodyMissing =
    !!material?.contentOmitted && seed !== undefined && (staticNote || !usable);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!bodyMissing) return;
    forgetNoteCopy(materialId);
    void queryClient.invalidateQueries({ queryKey: qk.material(materialId) });
  }, [bodyMissing, materialId, queryClient]);
  // The editor's chunk once the paint is up, not behind the read and the token.
  // Before the read answers its copy's row says, so a viewer's reopen never
  // loads it. A heavy note opened read-only never needs it.
  const mayEdit =
    !!painted &&
    !staticNote &&
    (material?.capabilities.canEditContent ?? seed?.row.canEditContent);
  useEffect(() => {
    if (mayEdit) void loadEditor();
  }, [mayEdit]);
  if (!(painted && label) || bodyMissing) return <NoteSkeleton />;
  // The same frame before its read answers as for an editor: the static note
  // keeps its DOM from one to the other, never painted twice.
  if (editing || !material) {
    if (material) handed.current ??= 'editor';
    return (
      <PaintedFrame
        allowExternalAssets={allowExternalAssets}
        citation={citation}
        editing={editing}
        key={materialId}
        label={label}
        material={material}
        materialId={materialId}
        onEditorStatusChange={onEditorStatusChange}
        onPresenceChange={onPresenceChange}
        onReadOnly={onReadOnly}
        painted={painted}
        seed={usable}
      />
    );
  }
  if (!staticNote && seed !== undefined) handed.current ??= 'reader';
  return (
    <div className="relative h-full min-h-0 overflow-auto">
      <NoteDisplayToggles />
      {citation && <NoteCitation citation={citation} />}
      <Suspense fallback={<NoteSkeleton />}>
        {!staticNote && seed !== undefined ? (
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
        <DocumentAttribution material={material} value={painted} />
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

/** How often an open Preview redraws while the note changes behind it. Blocks that
 * didn't change keep their identity and aren't drawn again, as in a reader's note. */
const PREVIEW_REFRESH_MS = 250;

/** The first of a static note's blocks under its scroller's top edge. */
function previewPlace(box: HTMLElement) {
  const root = box.querySelector('[data-slate-editor]');
  if (!root) return null;
  const top = box.getBoundingClientRect().top;
  const blocks = [...root.children];
  const index = blocks.findIndex(
    (block) => block.getBoundingClientRect().bottom > top
  );
  if (index < 0) return null;
  return { index, offset: blocks[index].getBoundingClientRect().top - top };
}

/** The whole note as its readers read it, drawn from the text in the editor kept
 * behind it (Epo 2026-11-06), so it reads nothing and shows what's typed, saved yet
 * or not. A collaborator's typing reaches it through the same editor. */
function NotePreview({
  box,
  editor,
  label,
  material,
  place,
}: {
  box: RefObject<HTMLDivElement | null>;
  editor: PlateEditor;
  label: PaintLabel;
  material: Material;
  /** Where the editor was, in this note's blocks. */
  place: NotePosition;
}) {
  const [value, setValue] = useState(() => editor.children as MaterialValue);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Plate's type leaves out Slate's onChange, which every change runs through.
    const slate = editor as unknown as { onChange: () => void };
    const before = slate.onChange;
    slate.onChange = () => {
      before();
      timer ??= setTimeout(() => {
        timer = undefined;
        setValue(editor.children as MaterialValue);
      }, PREVIEW_REFRESH_MS);
    };
    return () => {
      clearTimeout(timer);
      slate.onChange = before;
    };
  }, [editor]);
  // The same block at the same height, before the browser paints it.
  const start = useRef(place);
  useLayoutEffect(() => {
    const scroller = box.current;
    const index = (editor.children as MaterialValue).findIndex(
      (block) => block.id === start.current.block
    );
    const block = scroller?.querySelector('[data-slate-editor]')?.children[
      index
    ];
    if (scroller && block)
      scroller.scrollTop +=
        block.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        start.current.offset;
  }, [box, editor]);
  return (
    <div className="absolute inset-0 overflow-auto" ref={box}>
      <NoteDisplayToggles />
      <Suspense fallback={<NoteSkeleton />}>
        <PaintedNote label={label} material={material} value={value} />
        <DocumentAttribution material={material} value={value} />
      </Suspense>
    </div>
  );
}

/** How many blocks the frame paints until the reader nears their end: the
 * editor replaces them in moments, and a near-limit note's whole static DOM
 * would slow its build by about a second (bench/editor/reports). */
const PAINT_BLOCKS = 100;

/** An editor's note, and any note before its read answers: the paint on top
 * until Plate behind it has painted the room's document (or its saved copy,
 * past the join's 30 s), then Plate, at the reader's block and caret. At 30 s a
 * strip with Retry shows over whichever is on screen. The header's Preview puts
 * the readers' rendering over Plate, which stays mounted, joined and undoable. */
function PaintedFrame({
  allowExternalAssets,
  citation,
  editing,
  label,
  material,
  materialId,
  onEditorStatusChange,
  onPresenceChange,
  onReadOnly,
  painted,
  seed,
}: {
  allowExternalAssets: boolean;
  citation?: NoteCitationTarget;
  editing: boolean;
  label: PaintLabel;
  material: Material | undefined;
  materialId: string;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
  onPresenceChange?: (connections: PresenceConnection[] | null) => void;
  onReadOnly: (code?: ReadOnlyCode) => void;
  painted: MaterialValue;
  seed: RoomSeed | null | undefined;
}) {
  const builds = editing && !!material;
  // Its token alongside the paint, not behind the editor's chunk.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (builds) void queryClient.prefetchQuery(materialTokenQuery(materialId));
  }, [builds, materialId, queryClient]);
  const [shown, setShown] = useState(false);
  const paintBox = useRef<HTMLDivElement>(null);
  // A citation may point anywhere in the note.
  const [whole, setWhole] = useState(!!citation);
  const cut = !whole && painted.length > PAINT_BLOCKS;
  const firstBlocks = useMemo(
    () => (cut ? painted.slice(0, PAINT_BLOCKS) : painted),
    [cut, painted]
  );
  const paintEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const end = paintEnd.current;
    if (!end || shown) return;
    const near = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setWhole(true);
      },
      { root: paintBox.current, rootMargin: '100% 0px' }
    );
    near.observe(end);
    return () => near.disconnect();
  }, [cut, shown]);
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
  // The paint leaves at once and its DOM later: unmounting a near-limit note
  // would hold up the editor's first frame.
  const [paintGone, setPaintGone] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const go = () => setPaintGone(true);
    if (typeof requestIdleCallback !== 'function') {
      const timer = setTimeout(go, 200);
      return () => clearTimeout(timer);
    }
    const idle = requestIdleCallback(go, { timeout: 2000 });
    return () => cancelIdleCallback(idle);
  }, [shown]);
  const [joinFailed, setJoinFailed] = useState<{ retry: () => void } | null>(
    null
  );
  const headerActions = useContext(FileActionsTarget);
  const previewBox = useRef<HTMLDivElement>(null);
  // Where the editor was as Preview opened, with whether it held the focus.
  const [preview, setPreview] = useState<NotePosition | null>(null);
  const focusAtPress = useRef(false);
  const back = useRef<NotePosition | null>(null);
  const plate = editor?.editor;
  const togglePreview = () => {
    if (!(editor && plate)) return;
    if (!preview) {
      setPreview({
        ...captureNotePosition(editor),
        focused: focusAtPress.current,
      });
      return;
    }
    // The block Preview is at, by the value's ids; the caret and focus it left.
    const box = previewBox.current;
    const at = box && previewPlace(box);
    const block = at && (plate.children as MaterialValue)[at.index]?.id;
    back.current = at
      ? {
          ...preview,
          block: typeof block === 'string' ? block : preview.block,
          offset: at.offset,
        }
      : preview;
    setPreview(null);
  };
  // Plate is back on screen from this commit.
  useLayoutEffect(() => {
    if (preview || !back.current || !editor) return;
    restoreNotePosition(editor, back.current);
    back.current = null;
  }, [editor, preview]);
  // A citation points into the editor, where its passage flashes.
  useEffect(() => {
    if (citation) setPreview(null);
  }, [citation]);
  const previewing = !!(preview && plate && material);
  const onJoinFailed = useCallback(
    (retry: (() => void) | null) => setJoinFailed(retry && { retry }),
    []
  );
  return (
    <AppErrorBoundary resetKeys={[materialId]}>
      <div className="flex h-full min-h-0 flex-col">
        {joinFailed && (
          <SaveBanner onRetry={joinFailed.retry} state="unreachable" />
        )}
        <div className="relative min-h-0 flex-1">
          {!paintGone && (
            <div
              className="relative h-full min-h-0 overflow-auto"
              data-note-paint=""
              hidden={shown}
              ref={paintBox}
            >
              <NoteDisplayToggles toolbar={HELD_TOOLBAR} />
              {citation && <NoteCitation citation={citation} />}
              <EmbedViewContext.Provider value={HeldEmbed}>
                <Suspense fallback={<NoteSkeleton />}>
                  <PaintedNote
                    label={label}
                    material={material}
                    value={firstBlocks}
                  />
                  {cut && <div ref={paintEnd} />}
                  {material && !cut && (
                    <DocumentAttribution material={material} value={painted} />
                  )}
                </Suspense>
              </EmbedViewContext.Provider>
            </div>
          )}
          <div
            className={cn(
              'h-full',
              (!shown || previewing) && 'invisible absolute inset-0'
            )}
            inert={!shown || previewing}
          >
            {builds && (
              <Suspense fallback={null}>
                <NoteEditor
                  allowExternalAssets={allowExternalAssets}
                  materialId={materialId}
                  onEditorStatusChange={onEditorStatusChange}
                  onJoinFailed={onJoinFailed}
                  onPresenceChange={onPresenceChange}
                  onReadOnly={onReadOnly}
                  onShown={onShown}
                  seed={seed}
                />
              </Suspense>
            )}
          </div>
          {preview && plate && material && (
            <NotePreview
              box={previewBox}
              editor={plate}
              label={label}
              material={material}
              place={preview}
            />
          )}
        </div>
        {plate &&
          headerActions &&
          createPortal(
            <Button
              className="shrink-0"
              iconLeft={preview ? 'pencil' : 'view'}
              onClick={togglePreview}
              // Before the press takes the focus from the note.
              onPointerDown={() => {
                focusAtPress.current = plate.api.isFocused();
              }}
              size="sm"
              variant="outline"
            >
              <span className="max-sm:sr-only">
                {preview ? m.action_edit() : m.editor_embed_preview()}
              </span>
            </Button>,
            headerActions
          )}
      </div>
    </AppErrorBoundary>
  );
}

export type NoteBodyProps = ComponentProps<typeof NoteBody>;
