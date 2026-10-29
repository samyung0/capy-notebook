import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { useMe } from '@/api/hooks';
import type { Material } from '@/api/types';
import {
  isOutdatedBanner,
  recoveryBanner,
  SaveBanner,
} from '@/components/banners/SaveBanner';
import { CollaborationHold } from '@/features/collaboration/CollaborationHold';
import {
  type ItemRoomSnapshot,
  itemEditingStopped,
} from '@/features/collaboration/itemRoom';
import { itemSaveState } from '@/features/collaboration/LiveItemControls';
import { NoteSeatContext } from '@/features/collaboration/noteSeat';
import { NO_PRESENCE } from '@/features/collaboration/presence';
import { SlowedOpenLine } from '@/features/collaboration/SlowedOpen';
import { FileError, FileLoading } from '@/features/files/FileStates';
import {
  type MaterialValue,
  parseMaterialDocument,
} from '@/features/materials/document';
import {
  AppEmbedEdit,
  AppEmbedView,
} from '@/features/materials/embeds/AppEmbed';
import { EmbedLoading } from '@/features/materials/embeds/EmbedView';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { cn } from '@/lib/cn';
import { type BlocksRoom, createBlocksRoom } from './blocksRoom';
import { BlockIslands } from './islands';

const EMPTY: MaterialValue = [{ children: [{ text: '' }], type: 'p' }];

/** BlockSuite's editor, its own chunk: it loads while the room fetches its
 * token and syncs, instead of before (in dev, ~2,300 modules). */
let pageEditor:
  | Promise<typeof import('@/features/blocksuite/pageEditor')>
  | undefined;
function loadPageEditor() {
  pageEditor ??= import('@/features/blocksuite/pageEditor');
  return pageEditor;
}

/**
 * A note in the blocks layout (dev stacks, `VITE_DOCUMENT_LAYOUT=blocks`):
 * BlockSuite's page editor over the note's room. The editor mounts only once
 * the room synced under its adopted client id, and writes nothing while it
 * loads. Offline it stays editable under the offline strip, every edit
 * stored on this device (blocksRoom.ts). A room that ends here (refused,
 * moved, recovery left) is swapped, not remounted in place: the old view
 * stays on screen paused until the next one painted (Epo 2026-10-22). Lazy,
 * so BlockSuite stays out of every other chunk.
 */
export default function BlockSuiteNote({
  material,
  onEditorStatusChange,
}: {
  material: Material;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
}) {
  // Under MSW the room is seeded from the stored content, as the server
  // seeds it (`state_from_value`); a later refetch changes nothing.
  const [initialValue] = useState(
    () => parseMaterialDocument(material.content)?.value ?? EMPTY
  );
  const { data: me } = useMe();
  const { live, paused, painted } = useBlocksRooms(
    material.id,
    initialValue,
    me?.id ?? null
  );
  const snapshot = useSyncExternalStore(
    live?.room.subscribe ?? noSubscribe,
    live?.room.getSnapshot ?? connecting
  );
  const saveState = paused
    ? 'connecting'
    : snapshot.recovery
      ? 'error'
      : itemSaveState(snapshot.status, snapshot.offline);
  const { slowed } = snapshot;
  useEffect(() => {
    onEditorStatusChange?.(saveState ? { saveState, slowed } : null);
  }, [onEditorStatusChange, saveState, slowed]);
  useEffect(() => () => onEditorStatusChange?.(null), [onEditorStatusChange]);

  if (!live) return <FileLoading />;
  // One strip, the live room's: a paused view shows none.
  const banner = paused
    ? null
    : snapshot.recovery
      ? recoveryBanner(snapshot.recovery)
      : snapshot.offline;
  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {banner && (
        <SaveBanner onReload={() => void live.room.reload()} state={banner} />
      )}
      {[paused, live].map(
        (opened) =>
          opened && (
            <RoomView
              key={opened.key}
              onPainted={() => painted(opened)}
              opened={opened}
              phase={opened === paused ? 'paused' : paused ? 'standby' : 'live'}
            />
          )
      )}
    </div>
  );
}

type Opened = BlocksRoom & { key: number };
type Phase = 'live' | 'paused' | 'standby';

/**
 * The note's room and, while a replacement builds, the one it replaces:
 * created once `actorId` is known (drafts are kept per account), replaced
 * when it ends here, the old one destroyed once the new one painted
 * (`painted`) with the reader's place carried over.
 */
function useBlocksRooms(
  materialId: string,
  initialValue: MaterialValue,
  actorId: string | null
) {
  const [rooms, setRooms] = useState<{
    live: Opened | null;
    paused: Opened | null;
    painted: (opened: Opened) => void;
  }>({ live: null, painted: () => {}, paused: null });
  useEffect(() => {
    if (!actorId) return;
    let gone = false;
    let key = 0;
    let live: Opened;
    let paused: Opened | null = null;
    const publish = () => setRooms({ live, painted, paused });
    const painted = (opened: Opened) => {
      if (gone || opened !== live || !paused) return;
      const place = readingPlace(paused.key);
      paused.room.destroy();
      paused = null;
      publish();
      if (place) requestAnimationFrame(() => restorePlace(live.key, place));
    };
    const open = () => {
      const next: Opened = {
        ...createBlocksRoom(materialId, initialValue, {
          actorId,
          onReplace: () => {
            if (gone || next !== live) return;
            paused?.room.destroy();
            paused = live;
            open();
          },
        }),
        key: key++,
      };
      live = next;
      void next.room.start();
      publish();
    };
    open();
    void loadPageEditor();
    return () => {
      gone = true;
      live.room.destroy();
      paused?.room.destroy();
    };
  }, [materialId, initialValue, actorId]);
  return rooms;
}

const noSubscribe = () => () => {};
const CONNECTING: ItemRoomSnapshot = {
  access: null,
  listsVersion: 0,
  offline: null,
  presence: NO_PRESENCE,
  readOnlyCode: null,
  recovery: null,
  sending: false,
  slowed: false,
  status: 'connecting',
  synced: false,
};
const connecting = () => CONNECTING;

/** The top block showing in a view and how far below the box's top it sat
 * (a block id: the next room's document need not hold the same Yjs ids). */
interface Place {
  block: string;
  offset: number;
}

const scrollerOf = (key: number) =>
  document.querySelector<HTMLElement>(`[data-blocks-mount="${key}"]`);

function readingPlace(key: number): Place | null {
  const scroller = scrollerOf(key);
  if (!scroller) return null;
  const top = scroller.getBoundingClientRect().top;
  for (const element of scroller.querySelectorAll<HTMLElement>(
    '[data-block-id]'
  )) {
    const box = element.getBoundingClientRect();
    if (box.height > 0 && box.bottom > top) {
      const block = element.getAttribute('data-block-id');
      if (block) return { block, offset: box.top - top };
    }
  }
  return null;
}

function restorePlace(key: number, { block, offset }: Place) {
  const scroller = scrollerOf(key);
  const element = scroller?.querySelector<HTMLElement>(
    `[data-block-id="${CSS.escape(block)}"]`
  );
  if (!(scroller && element)) return;
  scroller.scrollTop +=
    element.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top -
    offset;
}

/** One room's view: its editor once synced, its copy-only recovery, or the
 * state it waits in. `standby` builds hidden beside the paused view and says
 * `onPainted` once it can take its place. */
function RoomView({
  opened,
  phase,
  onPainted,
}: {
  opened: Opened;
  phase: Phase;
  onPainted: () => void;
}) {
  const { room, seat, materialId, key } = opened;
  const snapshot = useSyncExternalStore(room.subscribe, room.getSnapshot);
  const { recovery, synced } = snapshot;
  // A failing open replaces the paused view at once, as a painted one does;
  // a hidden tab has nothing to keep on screen.
  const settled =
    snapshot.status === 'unavailable' ||
    (!synced &&
      !recovery &&
      (snapshot.status === 'offline' || isOutdatedBanner(snapshot.offline)));
  useEffect(() => {
    if (phase !== 'standby') return;
    if (settled || document.visibilityState === 'hidden') onPainted();
  }, [phase, settled, onPainted]);

  let content: ReactNode;
  if (snapshot.status === 'unavailable') content = <FileError />;
  else if (recovery)
    content = (
      <RecoveryEditor
        doc={recovery.doc}
        id={materialId}
        onPainted={onPainted}
      />
    );
  else if (isOutdatedBanner(snapshot.offline) && !synced)
    content = <SaveBanner state="outdated" />;
  else if (synced && room.awareness)
    content = (
      <CollaborationHold>
        <BlocksEditor
          awareness={room.awareness}
          doc={room.doc}
          id={materialId}
          onPainted={onPainted}
          readonly={
            phase === 'paused' ||
            snapshot.access !== 'write' ||
            itemEditingStopped(snapshot)
          }
        />
      </CollaborationHold>
    );
  else
    content = (
      <>
        <FileLoading />
        <SlowedOpenLine slowed={snapshot.slowed} />
      </>
    );
  return (
    <div
      aria-hidden={phase === 'standby' || undefined}
      className={cn(
        'h-full min-h-0 flex-1 overflow-y-auto',
        phase === 'standby' && 'invisible absolute inset-0'
      )}
      data-blocks-mount={key}
      data-blocksuite-note={phase === 'standby' ? undefined : ''}
      inert={phase === 'standby'}
    >
      <NoteSeatContext.Provider value={seat}>
        {content}
      </NoteSeatContext.Provider>
    </div>
  );
}

/** Edits that cannot join the room, read-only for copying until Reload
 * (Epo 2026-10-04; the merge view, Q251, has no blocks counterpart yet). */
function RecoveryEditor({
  doc,
  id,
  onPainted,
}: {
  doc: Y.Doc;
  id: string;
  onPainted: () => void;
}) {
  const [awareness, setAwareness] = useState<Awareness | null>(null);
  useEffect(() => {
    const created = new Awareness(doc);
    setAwareness(created);
    return () => created.destroy();
  }, [doc]);
  if (!awareness) return null;
  return (
    <BlocksEditor
      awareness={awareness}
      doc={doc}
      id={id}
      onPainted={onPainted}
      readonly
    />
  );
}

function BlocksEditor({
  awareness,
  doc,
  id,
  readonly,
  onPainted,
}: {
  awareness: Awareness;
  doc: Y.Doc;
  id: string;
  readonly: boolean;
  onPainted: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [islands] = useState(() => new BlockIslands());
  const editor = useRef<{
    setReadonly: (readonly: boolean) => void;
    unmount: () => void;
  } | null>(null);
  // Read when the editor mounts; later changes switch it in place.
  const latest = useRef({ onPainted, readonly });
  useEffect(() => {
    latest.current = { onPainted, readonly };
  });
  // A chunk that fails to load goes to the error boundary, as a lazy one.
  const [failed, setFailed] = useState<unknown>(null);
  if (failed) throw failed;
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // Not `use()`: suspending would hide and show this tree again, and in
    // dev StrictMode that runs the room's effect again (a second room).
    let live = true;
    loadPageEditor().then(({ mountNoteEditor }) => {
      if (!live) return;
      editor.current = mountNoteEditor(
        element,
        { awareness, doc, id, readonly: latest.current.readonly },
        islands
      );
      // Painted at the next frame; a hidden tab draws none.
      if (document.visibilityState === 'hidden') latest.current.onPainted();
      else requestAnimationFrame(() => live && latest.current.onPainted());
    }, setFailed);
    return () => {
      live = false;
      editor.current?.unmount();
      editor.current = null;
    };
  }, [awareness, doc, id, islands]);
  useEffect(() => {
    editor.current?.setReadonly(readonly);
  }, [readonly]);
  return (
    <>
      <div
        className="mx-auto w-full max-w-[768px] px-4 pt-6 pb-24"
        ref={container}
      />
      <MaterialRefIslands islands={islands} ownerId={id} readonly={readonly} />
    </>
  );
}

/** Each `capy:material-ref` block's embed, rendered into its block as the
 * Plate note's MaterialRefElement renders it: Edit edits the item in place,
 * View studies it. */
function MaterialRefIslands({
  islands,
  ownerId,
  readonly,
}: {
  islands: BlockIslands;
  ownerId: string;
  readonly: boolean;
}) {
  const list = useSyncExternalStore(islands.subscribe, islands.getSnapshot);
  return list.map(({ element, id, materialId, refKind, remove }) =>
    createPortal(
      materialId && !readonly ? (
        <AppEmbedEdit
          materialId={materialId}
          // The last question or card removed takes the block with it.
          onEmpty={remove}
          ownerId={ownerId}
          refKind={refKind}
        />
      ) : materialId ? (
        <AppEmbedView materialId={materialId} refKind={refKind} />
      ) : (
        <EmbedLoading />
      ),
      element,
      id
    )
  );
}
