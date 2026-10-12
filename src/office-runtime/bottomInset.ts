import { useEffect } from 'react';

/** Where the document scrolls: the grid, or the slide stage. Whatever lies
 * under it (sheet tabs, a narrow slide strip, the notes box) is bottom chrome. */
function documentArea(): Element | null {
  return (
    document.querySelector(
      '.xlsx-editor__scroll, .xlsx-viewport, .pptx-viewer-stage'
    ) ??
    document
      .querySelector('[data-testid="pptx-slide-canvas"]')
      ?.closest('[role="application"]') ??
    null
  );
}

/**
 * Reports the height of the frame's bottom chrome whenever it changes (sheet
 * tabs appearing, the notes box toggled, the narrow layout switching), so
 * Capy's floating tools button sits above it. The area keeps its bottom edge
 * while the toolbar row comes and goes, so only the chrome moves the inset.
 */
export function useBottomInset(
  active: boolean,
  report: (inset: number) => void
) {
  useEffect(() => {
    if (!active) return;
    let area: Element | null = null;
    let last = -1;
    const resize = new ResizeObserver(() => {
      if (!area) return;
      // Unrounded: a notes box can end between pixels.
      const inset = Math.max(
        0,
        window.innerHeight - area.getBoundingClientRect().bottom
      );
      if (inset === last) return;
      last = inset;
      report(inset);
    });
    // The editors mount their area once the file has loaded.
    const find = () => {
      const next = documentArea();
      if (next === area) return;
      if (area) resize.unobserve(area);
      area = next;
      if (area) resize.observe(area);
    };
    const mutations = new MutationObserver(find);
    mutations.observe(document.body, { childList: true, subtree: true });
    find();
    return () => {
      mutations.disconnect();
      resize.disconnect();
    };
  }, [active, report]);
}
