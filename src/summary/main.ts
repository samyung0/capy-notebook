import fileIcons from '@/assets/catppuccin.svg?no-inline';
import { bindPublicChrome } from '@/components/app/publicChrome';
import { applyFullStyles } from '@/lib/fullStyles';

/* The Worker renders the whole page, header and ⋮ included; this only wires
   the theme button, points the file icons at the sprite and counts the view,
   without React. */

bindPublicChrome();
// The page arrives with only the CSS its HTML uses; the menus and theme
// switch it renders are covered, and the rest is applied here.
void applyFullStyles();

// The summary and file panel reference the same Vite-hashed sprite.
for (const icon of document.querySelectorAll<SVGUseElement>(
  'use[data-file-icon]'
)) {
  icon.setAttribute('href', `${fileIcons}#${icon.dataset.fileIcon}`);
}

const workspaceId =
  document.getElementById('summary-actions')?.dataset.workspaceId;
// Analytics loads after the page, never ahead of it.
if (workspaceId)
  void import('@/lib/analytics').then(({ track }) =>
    track('summary_viewed', { workspaceId })
  );
