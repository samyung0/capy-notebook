import { createContext, useContext, useState } from 'react';
import { m } from '@/i18n';
import { reloadIntoNewRelease } from '@/lib/appRelease';
import { FileBanner, type FileBannerAction } from './FileBanner';

/**
 * An open editor's save strip, one state at a time:
 * - `delayed`: saves are failing or unconfirmed; the editor keeps its edits.
 * - `offline`: the room cannot be reached; edits are kept on this device.
 *   `offline-unstored`: and this device cannot store them (private mode, a
 *   full disk). `offline-limit`: the device holds as much as the file allows,
 *   and the editor stops taking edits until it reconnects.
 * - `refused`: a save was refused for good; `refused-size`: an Office or
 *   text file's, for its size limit (Q827 A). `changed`: the file moved on
 *   (a newer version, a room reset) while the edits waited to sync.
 *   `expired`: the edits are past the 7-day expiry, too old to sync.
 *   `deleted`: the item was deleted with unsent edits on this device (Q39).
 *   All of these show the edits read-only for copying (Office and text files
 *   and item rooms; a note opens the merge view instead, except when
 *   deleted, Q251) and cannot be closed. Their Discard (ghost-hover, first)
 *   drops the edits and continues from the last saved version, and their
 *   Download (dark) saves what shows, deleting nothing (Epo 2026-11-20,
 *   2026-11-21, and 2026-11-23 for all but `deleted`, in place of Reload):
 *   the editor's own (`onDownload`), a deleted item's its page's
 *   (`DeletedDownload`) first; with none, Discard stands alone.
 * - `outdated`: Capy was updated and the room refuses this build (the
 *   version gate); the editor is read-only, its edits stay on this device for
 *   the reloaded page to send, and Reload waits for the new app.
 *   `outdated-unstored`: and this device could not store the unsent edits,
 *   so the reload loses them.
 * - `late-unloaded`: a late note's merge code did not load; its edits stay
 *   read-only on this device until Retry or a reconnect loads it (Q398).
 * - `unsynced`: the room dropped a group of the editor's pieces as late (an
 *   uplink too slow for it, Epo 2026-11-23): its edits wait unsynced, with
 *   no timed retries, until Retry (dark, Epo 2026-11-23) joins again (a
 *   reconnect or a reload does too), or Discard (ghost-hover, first) drops
 *   them and continues from the last saved version, as the deleted strip's
 *   does; it cannot be closed.
 * - `unreachable`: a note's join ran past its 30 s (Epo 2026-11-04): over the
 *   note on screen, with Retry.
 * - `access-lost`: an Office or text file's room refused this editor, whose
 *   page stays read-only (Epo 2026-11-05).
 * - `review`: a note has edits that could not sync waiting in the merge view
 *   (Q252): Review opens it and Discard drops them all; it cannot be closed
 *   and has the lowest priority.
 */
export type SaveBannerState =
  | 'access-lost'
  | 'delayed'
  | 'deleted'
  | 'late-unloaded'
  | 'offline'
  | 'offline-unstored'
  | 'offline-limit'
  | 'refused'
  | 'refused-size'
  | 'changed'
  | 'expired'
  | 'outdated'
  | 'outdated-unstored'
  | 'review'
  | 'unreachable'
  | 'unsynced';

export function isOutdatedBanner(state: SaveBannerState | null | undefined) {
  return state === 'outdated' || state === 'outdated-unstored';
}

export function isRecoveryBanner(state: SaveBannerState | null) {
  return (
    state === 'refused' ||
    state === 'refused-size' ||
    state === 'changed' ||
    state === 'expired' ||
    state === 'deleted'
  );
}

/** The open page's Download of the deleted item's edits it shows (Epo
 * 2026-11-20), after the deleted strip's Discard; none where nothing
 * provides it. */
export const DeletedDownload = createContext<(() => void) | null>(null);

/** The strip of a copy-only group of stored edits. */
export function recoveryBanner(group: {
  deleted?: boolean;
  expired?: boolean;
  refused: boolean;
}): SaveBannerState {
  if (group.deleted) return 'deleted';
  if (group.expired) return 'expired';
  return group.refused ? 'refused' : 'changed';
}

const MESSAGES: Record<
  Exclude<SaveBannerState, 'outdated' | 'outdated-unstored'>,
  () => string
> = {
  'access-lost': () => m.editor_access_lost(),
  changed: () => m.editor_recovery_changed(),
  delayed: () => m.editor_save_delayed(),
  deleted: () => m.editor_deleted_strip(),
  expired: () => m.editor_recovery_expired(),
  'late-unloaded': () => m.editor_late_unloaded(),
  offline: () => m.editor_offline_banner(),
  'offline-limit': () => m.editor_offline_limit(),
  'offline-unstored': () => m.editor_offline_unstored(),
  refused: () => m.source_edit_recovery(),
  'refused-size': () => m.source_edit_recovery_size(),
  review: () => m.merge_strip(),
  unreachable: () => m.editor_collab_unavailable(),
  unsynced: () => m.editor_late_unloaded(),
};

/**
 * Render it only while its state lasts: closing hides it for that episode,
 * and the next episode mounts it again. One row in every state: its actions
 * take the close button's place where it has any.
 */
export function SaveBanner({
  state,
  onDiscard,
  onDownload,
  onReview,
  onRetry,
  discarding = false,
  retrying = false,
}: {
  state: SaveBannerState;
  /** The Discard of recovery and `unsynced`; `review`'s drops every piece
   * (after a confirmation). */
  onDiscard?: () => void;
  /** Recovery's Download: the page's own of what shows (an item's edits, a
   * file's draft). */
  onDownload?: () => void;
  /** `review`: open the merge view. */
  onReview?: () => void;
  /** The Retry of `late-unloaded`, `unreachable` and `unsynced`. */
  onRetry?: () => void;
  /** A Discard is under way: it waits. */
  discarding?: boolean;
  /** `unsynced`: its Retry's join is pending, so Retry waits (round 4,
   * finding 4). */
  retrying?: boolean;
}) {
  const shown = useContext(DeletedDownload);
  if (isOutdatedBanner(state))
    return <OutdatedBanner stored={state === 'outdated'} />;
  const review = state === 'review' && onReview && onDiscard;
  const retry =
    (state === 'late-unloaded' ||
      state === 'unreachable' ||
      state === 'unsynced') &&
    onRetry;
  const discard: FileBannerAction | null = onDiscard
    ? {
        disabled: discarding,
        label: m.action_discard(),
        onClick: onDiscard,
        variant: 'ghost-hover',
      }
    : null;
  // A deleted item's Download is its page's (the rows it shows, Q39); the
  // other recovery strips' the editor's own, of what it shows.
  const download = state === 'deleted' ? (shown ?? onDownload) : onDownload;
  const actions: FileBannerAction[] = review
    ? [
        { label: m.merge_review(), onClick: onReview },
        { label: m.merge_discard_all(), onClick: onDiscard },
      ]
    : isRecoveryBanner(state) && discard
      ? [
          discard,
          ...(download
            ? [
                {
                  label: m.action_download(),
                  onClick: download,
                  variant: 'dark' as const,
                },
              ]
            : []),
        ]
      : retry
        ? [
            ...(state === 'unsynced' && discard ? [discard] : []),
            {
              disabled: retrying,
              label: m.error_action_retry(),
              onClick: retry,
              // The unsynced strip's one main action, filled as recovery's
              // Download (Epo 2026-11-23).
              ...(state === 'unsynced' ? { variant: 'dark' as const } : {}),
            },
          ]
        : [];
  return (
    <FileBanner
      actions={actions}
      closeable={
        !(
          isRecoveryBanner(state) ||
          state === 'review' ||
          state === 'late-unloaded' ||
          state === 'unreachable' ||
          state === 'unsynced'
        )
      }
      inline
      kind={state}
      message={MESSAGES[state]()}
      testId="save-banner"
      tone={
        state === 'access-lost' ||
        state === 'deleted' ||
        state === 'offline' ||
        state === 'offline-limit' ||
        state === 'late-unloaded' ||
        state === 'review'
          ? 'neutral'
          : 'error'
      }
    />
  );
}

/** Reload loads the page only once the new app is served; until then the
 * strip says it is still being published. */
function OutdatedBanner({ stored }: { stored: boolean }) {
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
        publishing
          ? m.editor_outdated_publishing()
          : stored
            ? m.editor_outdated()
            : m.editor_outdated_unstored()
      }
      testId="save-banner"
    />
  );
}
