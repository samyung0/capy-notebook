import { useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { BlockToolbar } from '@/components/ui/BlockToolbar';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import type {
  ItemRoom,
  ItemRoomStatus,
} from '@/features/collaboration/itemRoom';
import { UndoButtons } from '@/features/collaboration/LiveItemControls';
import { FileActionsTarget } from '@/features/files/fileModeContext';
import { m } from '@/i18n';
import { CardDialog } from './CardDialog';
import { CardGrid, CardTile } from './CardView';
import { addCard, isBlank, readCards, removeCard, useCards } from './liveSet';

/** Edits a live flashcard set as a grid (Epo 2026-10-10): adding, editing
 * and removing a card change the set at once for everyone in it; there is
 * no Save, Reset or Done. A card added and left blank goes away when its
 * dialog closes, as the old save left blank cards out. */
export function FlashcardsEditor({
  room,
  status,
  setId,
  title,
  onEmpty,
  showTitle = true,
  showUndo = true,
}: {
  room: ItemRoom;
  status: ItemRoomStatus;
  setId: string;
  title: string;
  /** Inside a note: removing the last card removes the embed block. A set
   * of its own keeps at least one card. */
  onEmpty?: () => void;
  /** Off where the page header already names the set. */
  showTitle?: boolean;
  /** Off inside a note (the card dialog carries them). */
  showUndo?: boolean;
}) {
  const { doc, history: undo } = room;
  const cards = useCards(doc);
  // On a set's own page Undo and Redo sit in the header beside View, where
  // the mock places them; inside a note the card dialog carries them.
  const headerActions = useContext(FileActionsTarget);
  const [editing, setEditing] = useState<{ id: string; added: boolean } | null>(
    null
  );
  // The card waiting on the remove confirmation (main 621c3dd0).
  const [removing, setRemoving] = useState<string | null>(null);

  function remove(id: string) {
    if (cards.length <= 1) {
      onEmpty?.();
      return;
    }
    removeCard(doc, id);
  }

  function close() {
    if (editing?.added) {
      const card = readCards(doc).find((c) => c.id === editing.id);
      if (card && isBlank(card)) removeCard(doc, editing.id);
    }
    setEditing(null);
  }

  return (
    <div className="flex flex-col gap-6">
      {showUndo &&
        headerActions &&
        createPortal(<UndoButtons manager={undo} />, headerActions)}
      {(showTitle || (showUndo && !headerActions)) && (
        <div className="flex items-center gap-2">
          {showTitle && <h1 className="t-large-card-title">{title}</h1>}
          {showUndo && !headerActions && (
            <div className="ml-auto">
              <UndoButtons manager={undo} />
            </div>
          )}
        </div>
      )}
      <CardGrid>
        {cards.map((card) => (
          <CardTile
            card={card}
            key={card.id}
            label={m.flashcards_edit_card()}
            onOpen={() => setEditing({ added: false, id: card.id })}
          >
            <BlockToolbar className="absolute top-2 right-2 z-10 rounded-md p-0.5 opacity-0 pointer-coarse:opacity-100 transition-opacity group-hover/tile:opacity-100 has-focus-visible:opacity-100">
              <ToolbarButton
                label={m.action_edit()}
                onClick={() => setEditing({ added: false, id: card.id })}
                tooltipSide="top"
              >
                <Icon name="pencil" />
              </ToolbarButton>
              <ToolbarButton
                disabled={cards.length <= 1 && !onEmpty}
                label={m.editor_remove_card()}
                onClick={() => setRemoving(card.id)}
                tooltipSide="top"
                variant="danger-light"
              >
                <Icon name="trash" />
              </ToolbarButton>
            </BlockToolbar>
          </CardTile>
        ))}
        <Card
          border="dashed"
          className="aspect-[4/3] cursor-pointer items-center justify-center focus-visible:border-0 focus-visible:ring-2 focus-visible:ring-action focus-visible:transition-none"
          interactive
          onClick={() => setEditing({ added: true, id: addCard(doc) })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ')
              setEditing({ added: true, id: addCard(doc) });
          }}
          radius="card-lg"
          role="button"
          tabIndex={0}
        >
          <span className="flex flex-col items-center gap-2 text-fg-muted">
            <Icon name="plus" size={24} />
            <span className="t-meta text-fg-muted">
              {m.flashcards_add_card()}
            </span>
          </span>
        </Card>
      </CardGrid>

      {editing && (
        <CardDialog
          cardId={editing.id}
          doc={doc}
          onClose={close}
          onRemove={
            cards.length > 1 || onEmpty
              ? () => setRemoving(editing.id)
              : undefined
          }
          setId={setId}
          setTitle={title}
          status={status}
          undo={undo}
        />
      )}
      <ConfirmDialog
        body={m.editor_remove_card_confirm_body()}
        confirmLabel={m.action_remove()}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          if (editing?.id === removing) setEditing(null);
          remove(removing);
        }}
        open={removing !== null}
        title={m.editor_remove_card_confirm_title()}
      />
    </div>
  );
}
