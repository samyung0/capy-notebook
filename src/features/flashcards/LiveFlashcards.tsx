import { type ReactNode, useEffect, useState } from 'react';
import { useMe } from '@/api/hooks';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { SaveBanner } from '@/components/banners/SaveBanner';
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
 * to read; the room state goes to the header's save status like a note's.
 * Unsent edits stay on this device: offline, a banner says so; refused or
 * left behind by a room that moved on, they show read-only to copy until
 * Reload (Epo 2026-10-04). */
export function LiveFlashcards({
  setId,
  title,
  action,
  onEmpty,
  onStatusChange,
  showTitle,
  showUndo,
  enabled = true,
}: {
  setId: string;
  title: string;
  /** Sits right of the title. */
  action?: ReactNode;
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
  const { data: me } = useMe();
  const actorId = me?.id ?? null;
  const { room, snapshot } = useItemRoom(
    setId,
    (enabled || held) && !!actorId,
    { actorId }
  );
  useEffect(() => {
    setHeld(snapshot.status === 'syncing' || snapshot.status === 'offline');
  }, [snapshot.status]);
  const cards = useCards(room?.doc);
  const recovered = useCards(snapshot.recovery?.doc);
  useEffect(() => {
    const saveState = snapshot.recovery
      ? 'error'
      : itemSaveState(snapshot.status);
    onStatusChange?.(saveState ? { saveState } : null);
  }, [snapshot.status, snapshot.recovery, onStatusChange]);
  useEffect(() => () => onStatusChange?.(null), [onStatusChange]);

  if (snapshot.status === 'unavailable')
    return (
      <p className="t-meta text-fg-muted">{m.material_ref_unavailable()}</p>
    );
  if (room && snapshot.recovery)
    return (
      <div className="flex flex-col gap-4">
        <SaveBanner
          onReload={() => void room.reload()}
          state={snapshot.recovery.refused ? 'refused' : 'changed'}
        />
        <FlashcardGrid
          action={action}
          cards={recovered}
          title={showTitle ? title : ''}
        />
      </div>
    );
  // Opened offline (or the server failed): it joins once back.
  if (snapshot.status === 'offline' && !snapshot.synced)
    return <QueryPausedState />;
  if (!(room && snapshot.synced))
    return <Skeleton className="h-40 w-full rounded-card" />;
  const grid = (
    <FlashcardGrid
      action={action}
      cards={cards}
      title={showTitle ? title : ''}
    />
  );
  return (
    <div className="flex flex-col gap-4">
      {snapshot.offline && <SaveBanner state={snapshot.offline} />}
      {snapshot.access !== 'write' || snapshot.offline === 'offline-limit' ? (
        grid
      ) : (
        <FlashcardsEditor
          action={action}
          onEmpty={onEmpty}
          room={room}
          setId={setId}
          showTitle={showTitle}
          showUndo={showUndo}
          status={snapshot.status}
          title={title}
        />
      )}
    </div>
  );
}
