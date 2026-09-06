export interface PdfRect {
  height: number;
  width: number;
  x: number;
  y: number;
}
export interface PdfSelection {
  page: number;
  rects: PdfRect[];
}
const EPSILON = 0.01;

export function intersection(a: PdfRect, b: PdfRect): PdfRect | null {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width),
    bottom = Math.min(a.y + a.height, b.y + b.height);
  return right - x > EPSILON && bottom - y > EPSILON
    ? { height: bottom - y, width: right - x, x, y }
    : null;
}

export function subtractRect(rect: PdfRect, cut: PdfRect): PdfRect[] {
  const overlap = intersection(rect, cut);
  if (!overlap) return [rect];
  return [
    { height: overlap.y - rect.y, width: rect.width, x: rect.x, y: rect.y },
    {
      height: rect.y + rect.height - overlap.y - overlap.height,
      width: rect.width,
      x: rect.x,
      y: overlap.y + overlap.height,
    },
    {
      height: overlap.height,
      width: overlap.x - rect.x,
      x: rect.x,
      y: overlap.y,
    },
    {
      height: overlap.height,
      width: rect.x + rect.width - overlap.x - overlap.width,
      x: overlap.x + overlap.width,
      y: overlap.y,
    },
  ].filter((part) => part.width > EPSILON && part.height > EPSILON);
}

export function eraseRects(
  rects: readonly PdfRect[],
  cuts: readonly PdfRect[]
): PdfRect[] {
  return cuts.reduce<PdfRect[]>(
    (remaining, cut) => remaining.flatMap((rect) => subtractRect(rect, cut)),
    [...rects]
  );
}

export function fullyHighlighted(
  selection: readonly PdfRect[],
  highlights: readonly PdfRect[]
): boolean {
  return selection.length > 0 && eraseRects(selection, highlights).length === 0;
}

// Store geometry in the unrotated PDF page's top-left 0..1000 coordinates.
export function rotateRect(rect: PdfRect, rotation: number): PdfRect {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return {
        height: rect.width,
        width: rect.height,
        x: 1000 - rect.y - rect.height,
        y: rect.x,
      };
    case 180:
      return {
        height: rect.height,
        width: rect.width,
        x: 1000 - rect.x - rect.width,
        y: 1000 - rect.y - rect.height,
      };
    case 270:
      return {
        height: rect.width,
        width: rect.height,
        x: rect.y,
        y: 1000 - rect.x - rect.width,
      };
    default:
      return rect;
  }
}

export function clientRectToPage(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  page: HTMLElement
): PdfRect {
  const bounds = page.getBoundingClientRect();
  const clamp = (value: number) => Math.max(0, Math.min(1000, value));
  const x = clamp(((rect.left - bounds.left) / bounds.width) * 1000);
  const y = clamp(((rect.top - bounds.top) / bounds.height) * 1000);
  const right = clamp(
    ((rect.left + rect.width - bounds.left) / bounds.width) * 1000
  );
  const bottom = clamp(
    ((rect.top + rect.height - bounds.top) / bounds.height) * 1000
  );
  return rotateRect(
    { height: bottom - y, width: right - x, x, y },
    -Number(page.dataset.rotation ?? 0)
  );
}

export function pdfTextSelection(container: HTMLElement): PdfSelection[] {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return [];
  const pages = new Map<number, PdfRect[]>();
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const layer = node.parentElement?.closest(
        '.react-pdf__Page__textContent'
      );
      const page = layer?.closest<HTMLElement>('[data-page]');
      if (page && range.intersectsNode(node)) {
        const part = document.createRange();
        part.selectNodeContents(node);
        if (range.startContainer === node)
          part.setStart(node, range.startOffset);
        if (range.endContainer === node) part.setEnd(node, range.endOffset);
        if (!part.collapsed) {
          const number = Number(page.dataset.page);
          const rects = pages.get(number) ?? [];
          for (const rect of part.getClientRects())
            if (rect.width > 0 && rect.height > 0)
              rects.push(clientRectToPage(rect, page));
          pages.set(number, rects);
        }
      }
      node = walker.nextNode();
    }
  }
  return [...pages].map(([page, rects]) => ({ page, rects }));
}

export function toolbarPosition(
  cursor: { x: number; y: number },
  viewport: { left: number; top: number; right: number; bottom: number },
  width: number,
  height: number
) {
  const margin = 8;
  return {
    left: Math.max(
      viewport.left + margin,
      Math.min(cursor.x, viewport.right - width - margin)
    ),
    top: Math.max(
      viewport.top + margin,
      Math.min(
        cursor.y + height + 16 <= viewport.bottom
          ? cursor.y + 12
          : cursor.y - height - 12,
        viewport.bottom - height - margin
      )
    ),
  };
}

export function segmentIntersectsRect(
  start: { x: number; y: number },
  end: { x: number; y: number },
  rect: PdfRect
): boolean {
  let near = 0,
    far = 1;
  for (const [from, delta, minimum, maximum] of [
    [start.x, end.x - start.x, rect.x, rect.x + rect.width],
    [start.y, end.y - start.y, rect.y, rect.y + rect.height],
  ]) {
    if (delta === 0) {
      if (from < minimum || from > maximum) return false;
      continue;
    }
    const a = (minimum - from) / delta,
      b = (maximum - from) / delta;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return false;
  }
  return true;
}
