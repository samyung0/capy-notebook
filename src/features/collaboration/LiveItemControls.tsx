import { useCallback, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { Icon, type IconName } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import type { NoteEditorSaveState } from '@/features/notes/editorMode';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { ItemRoomStatus } from './itemRoom';

/** A live item's room state as the note header's save status reads it. */
export function itemSaveState(
  status: ItemRoomStatus
): NoteEditorSaveState | null {
  return status === 'unavailable' ? null : status;
}

const STATUS: Record<
  ItemRoomStatus,
  { icon: IconName; label: () => string } | null
> = {
  connecting: { icon: 'cloudSync', label: m.editor_connecting },
  offline: { icon: 'cloudOff', label: m.editor_status_offline },
  synced: { icon: 'CloudIcon', label: m.editor_status_synced },
  syncing: { icon: 'cloudSync', label: m.editor_status_syncing },
  unavailable: null,
};

/** The live status in an item dialog's footer: the note header's icons. */
export function LiveStatus({ status }: { status: ItemRoomStatus }) {
  const shown = STATUS[status];
  if (!shown) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[0.8125rem] text-fg-muted',
        status === 'offline' && 'text-tint-warning-fg'
      )}
      data-save-state={status}
      role="status"
    >
      <Icon className="size-4" name={shown.icon} />
      {shown.label()}
    </span>
  );
}

/** Undo and Redo of this user's own edits to one live item. */
export function UndoButtons({ manager }: { manager: Y.UndoManager }) {
  const subscribe = useCallback(
    (notify: () => void) => {
      manager.on('stack-item-added', notify);
      manager.on('stack-item-popped', notify);
      manager.on('stack-cleared', notify);
      return () => {
        manager.off('stack-item-added', notify);
        manager.off('stack-item-popped', notify);
        manager.off('stack-cleared', notify);
      };
    },
    [manager]
  );
  const canUndo = useSyncExternalStore(
    subscribe,
    () => manager.undoStack.length > 0
  );
  const canRedo = useSyncExternalStore(
    subscribe,
    () => manager.redoStack.length > 0
  );
  return (
    <span className="flex items-center">
      <ToolbarButton
        disabled={!canUndo}
        label={m.editor_undo()}
        onClick={() => manager.undo()}
      >
        <Icon name="undo" />
      </ToolbarButton>
      <ToolbarButton
        disabled={!canRedo}
        label={m.editor_redo()}
        onClick={() => manager.redo()}
      >
        <Icon name="redo" />
      </ToolbarButton>
    </span>
  );
}
