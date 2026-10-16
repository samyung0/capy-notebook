import { useState } from 'react';
import { m } from '@/i18n';
import { reloadIntoNewRelease } from '@/lib/appRelease';
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
 * - `outdated`: Capy was updated and the room refuses this build (the
 *   version gate); the editor is read-only, its edits stay on this device for
 *   the reloaded page to send, and Reload waits for the new app.
 */
export type SaveBannerState =
  | 'delayed'
  | 'offline'
  | 'offline-unstored'
  | 'offline-limit'
  | 'refused'
  | 'changed'
  | 'outdated';

export function isRecoveryBanner(state: SaveBannerState | null) {
  return state === 'refused' || state === 'changed';
}

const MESSAGES: Record<Exclude<SaveBannerState, 'outdated'>, () => string> = {
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
 * the close button's place in recovery and when outdated.
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
  if (state === 'outdated') return <OutdatedBanner />;
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
      kind={state}
      message={MESSAGES[state]()}
      testId="save-banner"
      tone={
        state === 'offline' || state === 'offline-limit' ? 'neutral' : 'error'
      }
    />
  );
}

/** Reload loads the page only once the new app is served; until then the
 * strip says it is still being published. */
function OutdatedBanner() {
  const [checking, setChecking] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const reload = async () => {
    setChecking(true);
    if (await reloadIntoNewRelease()) return;
    setPublishing(true);
    setChecking(false);
  };
  return (
    <FileBanner
      actions={[
        {
          disabled: checking,
          label: m.error_action_reload(),
          onClick: () => void reload(),
        },
      ]}
      closeable={false}
      inline
      kind="outdated"
      message={
        publishing ? m.editor_outdated_publishing() : m.editor_outdated()
      }
      testId="save-banner"
    />
  );
}
