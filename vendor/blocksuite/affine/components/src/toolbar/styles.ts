// Capy (local change 34): upstream pinned AFFiNE's own light or dark palette on each
// bar here (`[data-app-theme]` rules setting fourteen colour variables from
// `@toeverything/theme`), over anything the page set. The app maps those variables
// onto its tokens at the root (src/features/blocksuite/chrome.css), which already
// follow its theme, so a bar reads them like every other part and these add nothing.

export const lightToolbarStyles = (_selector: string) => '';

export const darkToolbarStyles = (_selector: string) => '';
