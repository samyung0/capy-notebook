import type { DisplayPage } from '@betteroffice/docx/layout/render';
import type { OfficeParagraphPoint } from '@/features/files/officeProtocol';

/** Body paragraphs in the page mirrors (headers and footers repeat theirs on
 * every page), split ones by fragment. */
export const BODY_PARAGRAPH = '.layout-page-content [data-para-id]';

/** The first body paragraph fragment showing at the box's top, and how far
 * below the top edge it starts; mirrors run in document order. The editor's
 * and View's mirrors carry the same attributes. */
export function topParagraph(area: HTMLElement) {
  const edge = area.getBoundingClientRect().top;
  for (const fragment of area.querySelectorAll<HTMLElement>(BODY_PARAGRAPH)) {
    const rect = fragment.getBoundingClientRect();
    const paraId = fragment.dataset.paraId;
    if (rect.height > 0 && rect.bottom > edge && paraId)
      return {
        line:
          fragment.dataset.fromLine === undefined
            ? null
            : Number(fragment.dataset.fromLine),
        offset: rect.top - edge,
        paraId,
      };
  }
  return null;
}

/** A run of the text layer with document positions (a text box's have none). */
const POSITIONED_RUN = '.layout-run-text[data-doc-start]';
/** Where positions count in another story than the body's, or none. */
const NOT_BODY =
  '.layout-note, .layout-page-notes, .layout-page-header, .layout-page-footer, [role="cell"], [role="columnheader"]';

/**
 * View's text-layer selection as the editor names a selection: anchor and head
 * by body paragraph id and offset. View lays out the same seeded engine state
 * as the editor (docx-view-wasm), so its runs' positions are the editor's:
 * a paragraph opens at its first fragment's start and its text starts one
 * after, as the editor's position map counts (`displayPositionToYrsLoc`).
 * Null when either end is outside a body paragraph with an id (notes, headers,
 * table cells and text boxes are stories of their own) or not in a run's text.
 */
export function textLayerSelection(
  selection: Selection | null,
  pages: readonly DisplayPage[]
): { anchor: OfficeParagraphPoint; head: OfficeParagraphPoint } | null {
  if (!selection?.anchorNode || !selection.focusNode) return null;
  const anchor = paragraphPoint(
    selection.anchorNode,
    selection.anchorOffset,
    pages
  );
  const head = paragraphPoint(
    selection.focusNode,
    selection.focusOffset,
    pages
  );
  return anchor && head ? { anchor, head } : null;
}

function paragraphPoint(
  node: Node,
  offset: number,
  pages: readonly DisplayPage[]
): OfficeParagraphPoint | null {
  // A cluster run holds its text node alone.
  if (node.nodeType !== node.TEXT_NODE) return null;
  const run = node.parentElement?.closest<HTMLElement>(POSITIONED_RUN);
  const paraId = run?.closest<HTMLElement>('[data-para-id]')?.dataset.paraId;
  if (!(run && paraId) || run.closest(NOT_BODY)) return null;
  const position = Math.min(
    Number(run.dataset.docStart) + offset,
    Number(run.dataset.docEnd)
  );
  const page = Number(
    run.closest<HTMLElement>('[data-page-index]')?.dataset.pageIndex
  );
  const start = paragraphStart(pages, page, paraId, position);
  if (!Number.isFinite(position) || start === null) return null;
  return {
    offset: Math.max(0, position - start - 1),
    paraId,
    story: 'body',
  };
}

/** Where the paragraph `paraId` holding `position` opens: its first
 * fragment's start, on this page or one before it. */
function paragraphStart(
  pages: readonly DisplayPage[],
  pageIndex: number,
  paraId: string,
  position: number
) {
  for (let index = pageIndex; index >= 0; index--) {
    let start: number | null = null;
    for (const primitive of pages[index]?.primitives ?? []) {
      if (
        !('paraId' in primitive) ||
        primitive.paraId !== paraId ||
        primitive.fromLine !== 0 ||
        primitive.fragmentDocStart === undefined ||
        primitive.fragmentDocStart > position
      )
        continue;
      start = Math.max(start ?? -1, primitive.fragmentDocStart);
    }
    if (start !== null) return start;
  }
  return null;
}
