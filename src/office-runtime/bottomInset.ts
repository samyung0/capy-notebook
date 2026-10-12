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
      // An area the editor replaced is looked for again.
      if (!area?.isConnected) {
        resize.disconnect();
        area = null;
        look();
        return;
      }
      // Unrounded: a notes box can end between pixels.
      const inset = Math.max(
        0,
        window.innerHeight - area.getBoundingClientRect().bottom
      );
      if (inset === last) return;
      last = inset;
      report(inset);
    });
    // The area moves only when it, or a box beside one of its ancestors,
    // changes size: watching them all catches a move without a resize too.
    const watch = (found: Element) => {
      area = found;
      resize.observe(found);
      for (let box = found.parentElement; box; box = box.parentElement) {
        for (const child of box.children)
          if (!child.contains(found)) resize.observe(child);
        if (box === document.body) break;
      }
    };
    // The editors mount their area once the file has loaded; looking stops
    // once it is there.
    const mutations = new MutationObserver(() => {
      const found = documentArea();
      if (!found) return;
      mutations.disconnect();
      watch(found);
    });
    const look = () => {
      const found = documentArea();
      if (found) watch(found);
      else mutations.observe(document.body, { childList: true, subtree: true });
    };
    look();
    return () => {
      mutations.disconnect();
      resize.disconnect();
    };
  }, [active, report]);
}
