/** A reader's place in a PDF: the page under the pane's middle (its index) and
 * how far down that page the middle sits. */
interface PdfPlace {
  fraction: number;
  page: number;
}

const pageSelector = '[data-page]';

/** The pane's middle, in the viewport's coordinates. */
function paneMiddle(scroller: HTMLElement) {
  return (
    scroller.getBoundingClientRect().top +
    scroller.clientTop +
    scroller.clientHeight / 2
  );
}

function readPlace(
  scroller: HTMLElement,
  pages: NodeListOf<Element>
): PdfPlace | null {
  const middle = paneMiddle(scroller);
  // The last page starting above the middle: pages run top to bottom, and a
  // file can have thousands, so no scroll reads them all.
  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const probe = Math.ceil((low + high) / 2);
    if (pages[probe].getBoundingClientRect().top <= middle) low = probe;
    else high = probe - 1;
  }
  const box = pages[low]?.getBoundingClientRect();
  if (!box?.height) return null;
  return { fraction: (middle - box.top) / box.height, page: low };
}

function restorePlace(
  scroller: HTMLElement,
  pages: NodeListOf<Element>,
  { fraction, page }: PdfPlace
) {
  const box = pages[page]?.getBoundingClientRect();
  if (!box) return;
  scroller.scrollTop += box.top + fraction * box.height - paneMiddle(scroller);
}

/**
 * Keeps the reader on the same spot of the same page when the pages change
 * size: a zoom, a side panel dragged, a page measured as it loads. The scroll
 * offset alone would land on another page, since every page above grows or
 * shrinks. A reader at the very top stays there. Returns the stop.
 */
export function keepPdfPlace(scroller: HTMLElement, content: HTMLElement) {
  let place: PdfPlace | null = null;
  let height = content.offsetHeight;
  const pages = () => content.querySelectorAll(pageSelector);
  const onScroll = () => {
    // A resize not yet handled: this offset belongs to the old size.
    if (content.offsetHeight !== height) return;
    place = scroller.scrollTop > 0 ? readPlace(scroller, pages()) : null;
  };
  const observer = new ResizeObserver(() => {
    height = content.offsetHeight;
    if (place) restorePlace(scroller, pages(), place);
  });
  scroller.addEventListener('scroll', onScroll, { passive: true });
  observer.observe(content);
  return () => {
    scroller.removeEventListener('scroll', onScroll);
    observer.disconnect();
  };
}
