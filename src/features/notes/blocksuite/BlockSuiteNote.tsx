import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Material } from '@/api/types';
import { NoteSeatContext } from '@/features/collaboration/noteSeat';
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
import { BlocksRoom } from './blocksRoom';
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
 * loads. Lazy, so BlockSuite stays out of every other chunk.
 */
export default function BlockSuiteNote({ material }: { material: Material }) {
  // Under MSW the room is seeded from the stored content, as the server
  // seeds it (`state_from_value`); a later refetch changes nothing.
  const [initialValue] = useState(
    () => parseMaterialDocument(material.content)?.value ?? EMPTY
  );
  const [room, setRoom] = useState<BlocksRoom | null>(null);
  useEffect(() => {
    const next = new BlocksRoom(material.id, initialValue);
    setRoom(next);
    void next.start();
    void loadPageEditor();
    return () => next.destroy();
  }, [material.id, initialValue]);
  if (!room) return <FileLoading />;
  return <RoomEditor key={material.id} room={room} />;
}

function RoomEditor({ room }: { room: BlocksRoom }) {
  const state = useSyncExternalStore(room.subscribe, room.getSnapshot);
  const container = useRef<HTMLDivElement>(null);
  const readonly = state.status === 'ready' && state.readonly;
  const ready = state.status === 'ready';
  const [islands] = useState(() => new BlockIslands());
  // A chunk that fails to load goes to the error boundary, as a lazy one.
  const [failed, setFailed] = useState<unknown>(null);
  if (failed) throw failed;
  useEffect(() => {
    const element = container.current;
    if (!(ready && element)) return;
    // Not `use()`: suspending would hide and show this tree again, and in
    // dev StrictMode that runs the room's effect again (a second room).
    let live = true;
    let unmount: (() => void) | undefined;
    loadPageEditor().then(({ mountNoteEditor }) => {
      if (!live) return;
      unmount = mountNoteEditor(
        element,
        {
          awareness: room.awareness,
          doc: room.doc,
          id: room.materialId,
          readonly,
        },
        islands
      );
    }, setFailed);
    return () => {
      live = false;
      unmount?.();
    };
  }, [islands, ready, readonly, room]);

  if (state.status === 'unavailable') return <FileError />;
  return (
    <div className="h-full overflow-y-auto" data-blocksuite-note>
      {!ready && <FileLoading />}
      <div
        className="mx-auto w-full max-w-[768px] px-4 pt-6 pb-24"
        ref={container}
      />
      <NoteSeatContext.Provider value={room.seat}>
        <MaterialRefIslands
          islands={islands}
          ownerId={room.materialId}
          readonly={readonly}
        />
      </NoteSeatContext.Provider>
    </div>
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
