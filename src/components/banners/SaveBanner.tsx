import { m } from '@/i18n';
import { FileBanner } from './FileBanner';

/**
 * An open editor's save strip. `delayed`: saves are failing or unconfirmed
 * and the editor keeps its edits. `recovery`: the edits cannot be saved (a
 * save refused for good, a newer version, a draft from another version) and
 * the editor shows them read-only for copying until Reload.
 */
export type SaveBannerState = 'delayed' | 'recovery';

/**
 * Render it only while its state lasts: closing hides it for that episode,
 * and the next episode mounts it again. One row in every state: Reload takes
 * the close button's place in recovery, which cannot be closed.
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
  if (state === 'delayed')
    return (
      <FileBanner
        inline
        message={m.editor_save_delayed()}
        testId="save-banner"
        tone="error"
      />
    );
  return (
    <FileBanner
      actions={
        onReload
          ? [
              {
                disabled: reloading,
                label: m.error_action_reload(),
                onClick: onReload,
              },
            ]
          : []
      }
      closeable={false}
      inline
      message={m.source_edit_recovery()}
      testId="save-banner"
      tone="error"
    />
  );
}
