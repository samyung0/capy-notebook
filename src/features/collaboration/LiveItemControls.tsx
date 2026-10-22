import { useSyncExternalStore } from 'react';
import { isOutdatedBanner } from '@/components/banners/SaveBanner';
import { Icon, type IconName } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import type { NoteEditorSaveState } from '@/features/notes/editorMode';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useCollaborationHeld } from './held';
import type { ItemRoomSnapshot, ItemRoomStatus } from './itemRoom';
import type { UndoTarget } from './undo';

/** A live item's room state as the note header's save status reads it. */
export function itemSaveState(
  status: ItemRoomStatus,
  offline?: ItemRoomSnapshot['offline']
): NoteEditorSaveState | null {
  // Refused as outdated: stopped until the page reloads, as recovery.
  if (isOutdatedBanner(offline)) return 'error';
  return status === 'unavailable' ? null : status;
}

const STATUS: Record<
  ItemRoomStatus,
  { icon: IconName; label: () => string } | null
> = {
  connecting: { icon: 'cloudSync', label: m.editor_connecting },
  offline: { icon: 'cloudOff', label: m.editor_status_offline },
  saved: { icon: 'CloudIcon', label: m.editor_status_saved },
  syncing: { icon: 'cloudSync', label: m.editor_status_syncing },
  unavailable: null,
};

/** The live status in an item dialog's footer: the note header's icons.
 * `compact` (after a page title, as on notes) shows the icon alone. */
export function LiveStatus({
  status,
  compact,
}: {
  status: ItemRoomStatus;
  compact?: boolean;
}) {
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
      title={compact ? shown.label() : undefined}
    >
      {/* Lifted 1px to Fustat's cap band, level with the label. */}
      <Icon
        className={cn(compact ? 'size-4.5' : 'size-4 -translate-y-px')}
        name={shown.icon}
      />
      <span className={cn(compact && 'sr-only')}>{shown.label()}</span>
    </span>
  );
}

/** Undo and Redo of this user's own edits to one live item. `header` lifts
 * the icons 1px from lg, level with the View toggle's icon beside them;
 * `footer` lifts them 1px always, level with the live status text. */
export function UndoButtons({
  manager,
  header,
  footer,
}: {
  manager: UndoTarget;
  header?: boolean;
  footer?: boolean;
}) {
  const { subscribe } = manager;
  const canUndo = useSyncExternalStore(
    subscribe,
    manager.canUndo,
    manager.canUndo
  );
  const canRedo = useSyncExternalStore(
    subscribe,
    manager.canRedo,
    manager.canRedo
  );
  // The header copy portals out of the editor's inert wrapper.
  const held = useCollaborationHeld();
  return (
    <span className="flex items-center">
      <ToolbarButton
        disabled={held || !canUndo}
        label={m.editor_undo()}
        onClick={() => manager.undo()}
      >
        <Icon
          className={cn(
            header && 'lg:-translate-y-px',
            footer && '-translate-y-px'
          )}
          name="undo"
        />
      </ToolbarButton>
      <ToolbarButton
        disabled={held || !canRedo}
        label={m.editor_redo()}
        onClick={() => manager.redo()}
      >
        <Icon
          className={cn(
            header && 'lg:-translate-y-px',
            footer && '-translate-y-px'
          )}
          name="redo"
        />
      </ToolbarButton>
    </span>
  );
}
