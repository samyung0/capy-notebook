import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { useItemRoom } from '@/features/collaboration/itemRoom';
import { itemSaveState } from '@/features/collaboration/LiveItemControls';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { m } from '@/i18n';
import { FlashcardGrid } from './FlashcardGrid';
import { FlashcardsEditor } from './FlashcardsEditor';
import { useCards } from './liveSet';

/** A set's live editor: joins its room and edits the document once synced.
 * A read-only room (a frozen account, an owner at its limit) shows the grid
 * to read; the room state goes to the header's save status like a note's. */
export function LiveFlashcards({
  setId,
  title,
  onEmpty,
  onStatusChange,
  showTitle,
  showUndo,
  enabled = true,
}: {
  setId: string;
  title: string;
  onEmpty?: () => void;
  onStatusChange?: (status: NoteEditorStatus | null) => void;
  showTitle?: boolean;
  showUndo?: boolean;
  /** Joined only while wanted (a note's embed while on screen). */
  enabled?: boolean;
}) {
  // Edits the server has not acknowledged keep the room joined (offline,
  // or an embed that just scrolled away).
  const [held, setHeld] = useState(false);
  const { room, snapshot } = useItemRoom(setId, enabled || held);
  useEffect(() => {
    setHeld(snapshot.status === 'syncing' || snapshot.status === 'offline');
  }, [snapshot.status]);
  const cards = useCards(room?.doc);
  useEffect(() => {
    const saveState = itemSaveState(snapshot.status);
    onStatusChange?.(saveState ? { saveState } : null);
  }, [snapshot.status, onStatusChange]);
  useEffect(() => () => onStatusChange?.(null), [onStatusChange]);

  if (snapshot.status === 'unavailable')
    return (
      <p className="t-meta text-fg-muted">{m.material_ref_unavailable()}</p>
    );
  if (!(room && snapshot.synced))
    return <Skeleton className="h-40 w-full rounded-card" />;
  if (snapshot.access !== 'write')
    return <FlashcardGrid cards={cards} title={showTitle ? title : ''} />;
  return (
    <FlashcardsEditor
      onEmpty={onEmpty}
      room={room}
      setId={setId}
      showTitle={showTitle}
      showUndo={showUndo}
      status={snapshot.status}
      title={title}
    />
  );
}
