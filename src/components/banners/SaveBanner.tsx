import { m } from '@/i18n';
import { FileBanner } from './FileBanner';

/**
 * An open editor's save strip, one state at a time:
 * - `delayed`: saves are failing or unconfirmed; the editor keeps its edits.
 * - `offline`: the room cannot be reached; edits are kept on this device.
 *   `offline-unstored`: and this device cannot store them (private mode, a
 *   full disk). `offline-limit`: the device holds as much as the file allows,
 *   and the editor stops taking edits until it reconnects.
 * - `refused`: a save was refused for good. `changed`: the file moved on
 *   (a newer version, a room reset) while the edits waited to sync. Both show
 *   the edits read-only for copying; Reload is the only way out, so these two
 *   cannot be closed.
 */
export type SaveBannerState =
  | 'delayed'
  | 'offline'
  | 'offline-unstored'
  | 'offline-limit'
  | 'refused'
  | 'changed';

export function isRecoveryBanner(state: SaveBannerState | null) {
  return state === 'refused' || state === 'changed';
}

const MESSAGES: Record<SaveBannerState, () => string> = {
  changed: () => m.editor_recovery_changed(),
  delayed: () => m.editor_save_delayed(),
  offline: () => m.editor_offline_banner(),
  'offline-limit': () => m.editor_offline_limit(),
  'offline-unstored': () => m.editor_offline_unstored(),
  refused: () => m.source_edit_recovery(),
};

/**
 * Render it only while its state lasts: closing hides it for that episode,
 * and the next episode mounts it again. One row in every state: Reload takes
 * the close button's place in recovery.
 */
export function SaveBanner({
  state,
  onReload,
  reloading = false,
}: {
  state: SaveBannerState;
  onReload?: () => void;
  reloading?: boolean;
}) {
  return (
    <FileBanner
      actions={
        isRecoveryBanner(state) && onReload
          ? [
              {
                disabled: reloading,
                label: m.error_action_reload(),
                onClick: onReload,
              },
            ]
          : []
      }
      closeable={!isRecoveryBanner(state)}
      inline
      message={MESSAGES[state]()}
      testId="save-banner"
      tone={
        state === 'offline' || state === 'offline-limit' ? 'neutral' : 'error'
      }
    />
  );
}
