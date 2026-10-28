import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Material } from '@/api/types';
import { mountNoteEditor } from '@/features/blocksuite/pageEditor';
import { FileError, FileLoading } from '@/features/files/FileStates';
import {
  type MaterialValue,
  parseMaterialDocument,
} from '@/features/materials/document';
import { BlocksRoom } from './blocksRoom';

const EMPTY: MaterialValue = [{ children: [{ text: '' }], type: 'p' }];

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
  useEffect(() => {
    if (!(ready && container.current)) return;
    return mountNoteEditor(container.current, {
      awareness: room.awareness,
      doc: room.doc,
      id: room.materialId,
      readonly,
    });
  }, [ready, readonly, room]);

  if (state.status === 'unavailable') return <FileError />;
  return (
    <div className="h-full overflow-y-auto" data-blocksuite-note>
      {!ready && <FileLoading />}
      <div
        className="mx-auto w-full max-w-[768px] px-4 pt-6 pb-24"
        ref={container}
      />
    </div>
  );
}
