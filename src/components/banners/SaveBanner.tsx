import { m } from '@/i18n';
import { FileBanner } from './FileBanner';

/**
 * An open editor's save strip. `delayed`: saves are failing or unconfirmed
 * and the editor keeps its edits. `refused`: a save was refused for good and
 * the editor shows its unsaved content read-only until Reload.
 */
export type SaveBannerState = 'delayed' | 'refused';

/**
 * Render it only while its state lasts: closing hides it for that episode,
 * and the next episode mounts it again.
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
      message={m.source_edit_refused_recovery()}
      testId="save-banner"
      tone="error"
    />
  );
}
