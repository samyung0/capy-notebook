import {
  type DisplayList,
  glyphRunRect,
  textRunRect,
} from '@betteroffice/docx/layout/render';
import type { SlideDisplayList } from '@betteroffice/pptx/viewer';
import type { OfficeCitation } from '@/features/files/officeProtocol';

export type CitationRect = { x: number; y: number; w: number; h: number };
export const CITATION_FILL = 'rgba(255, 196, 0, 0.3)';

function normalized(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\u00ad/g, '')
    .replace(/-\s*\n\s*/g, '')
    .replace(/\s+/g, '');
}

/** Match only a complete, unique quote. Page numbers from an Office PDF are
 * not native document identities. Short/ambiguous quotes simply open the file. */
export function uniqueCitation<T extends { text: string }>(
  items: T[],
  quote: string
): T | null {
  const needle = normalized(quote);
  if (needle.length < 12 || needle.length > 4000) return null;
  let result: T | null = null;
  for (const item of items) {
    const text = normalized(item.text);
    const index = text.indexOf(needle);
    if (index < 0) continue;
    if (result || text.indexOf(needle, index + 1) >= 0) return null;
    result = item;
  }
  return result;
}

export function insidePage(
  rect: CitationRect,
  width: number,
  height: number
): boolean {
  return (
    [rect.x, rect.y, rect.w, rect.h, width, height].every(Number.isFinite) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.w > 0 &&
    rect.h > 0 &&
    rect.x + rect.w <= width &&
    rect.y + rect.h <= height
  );
}

export function docxCitation(
  list: DisplayList,
  citation: OfficeCitation | null
) {
  if (!citation) return null;
  const paragraphs = new Map<
    string,
    {
      text: string;
      safe: boolean;
      rects: Array<CitationRect & { page: number }>;
    }
  >();
  for (const page of list.pages) {
    for (const item of page.primitives) {
      if (item.kind !== 'text' && item.kind !== 'glyphRun') continue;
      const identity = item.blockKey ?? item.paraId;
      if (!identity) continue;
      const key = String(identity);
      const group = paragraphs.get(key) ?? { rects: [], safe: true, text: '' };
      group.text += item.text;
      const rect =
        item.kind === 'text' ? textRunRect(item) : glyphRunRect(item);
      // Off-page or transformed text has unreliable overlay geometry.
      if (
        !item.hiddenObject &&
        !item.hidden &&
        !item.rotationDeg &&
        !item.rtl &&
        (!item.paintClip ||
          ([item.paintClip.x, item.paintClip.w].every(Number.isFinite) &&
            item.paintClip.w > 0 &&
            rect.x >= item.paintClip.x &&
            rect.x + rect.w <= item.paintClip.x + item.paintClip.w)) &&
        !item.clipGroup?.clip &&
        (item.clipGroup?.opacity === undefined ||
          item.clipGroup.opacity === 1) &&
        (item.opacity === undefined || item.opacity === 1) &&
        insidePage(rect, page.width, page.height)
      ) {
        group.rects.push({ ...rect, page: page.pageIndex });
      } else {
        group.safe = false;
      }
      paragraphs.set(key, group);
    }
  }
  const match = uniqueCitation([...paragraphs.values()], citation.quote);
  return match?.safe ? match : null;
}

export function slideCitationItems(frame: SlideDisplayList) {
  return frame.primitives.flatMap((item) => {
    if (item.kind !== 'textBox') return [];
    const text = item.paragraphs
      .map((p) => p.runs.map((r) => r.text).join(''))
      .join('\n');
    const lines = item.lines.map((line) => ({
      h: line.height,
      w: line.width,
      x: line.x,
      y: line.y,
    }));
    const rects =
      item.overflow ||
      item.transform?.rotationDeg ||
      item.transform?.flipH ||
      item.transform?.flipV ||
      !lines.every(
        (rect) =>
          insidePage(rect, frame.width, frame.height) &&
          insidePage(
            { ...rect, x: rect.x - item.x, y: rect.y - item.y },
            item.w,
            item.h
          )
      )
        ? []
        : lines;
    return [{ rects, text }];
  });
}
