import { type DisplayList, paintDisplayList } from '@betteroffice/xlsx/viewer';
import type { OfficeRenderedPage } from '@/features/files/officeProtocol';
import { canvasPage } from './runtimeMenus';

interface Viewport {
  height: number;
  width: number;
  x: number;
  y: number;
}

/**
 * The display list of any part of the active sheet: the viewer's at once, the
 * editor's from its workbook worker.
 */
type Draw = (viewport: Viewport) => DisplayList | Promise<DisplayList>;

interface Extent {
  contentHeight: number;
  contentWidth: number;
  frozenCols: number;
  frozenRows: number;
}

/** A4 portrait at 96 px per inch, with 1 cm margins. */
const PAGE = { height: 1123, margin: 38, width: 794 };
const INNER = {
  height: PAGE.height - 2 * PAGE.margin,
  width: PAGE.width - 2 * PAGE.margin,
};
/** Pages printed at most (Epo: 50, with a notice when the sheet is longer). */
export const MAX_PAGES = 50;
const SCALE = 2;

/**
 * Where a printed page ends along one axis: at the last track edge that fits
 * (the whole of an oversized track otherwise), and how far the scrolled
 * tracks past the frozen ones moved, which is where the next page starts.
 */
export function pageCut(
  edges: readonly number[],
  frozen: number,
  limit: number
) {
  const start = edges[Math.min(frozen, edges.length - 1)] ?? 0;
  let size = limit;
  for (const edge of edges) if (edge > start && edge <= limit) size = edge;
  return { advance: Math.max(0, size - start), frozen: start, size };
}

function canvas(width: number, height: number) {
  const element = document.createElement('canvas');
  element.width = Math.round(width * SCALE);
  element.height = Math.round(height * SCALE);
  const context = element.getContext('2d');
  if (!context) throw new Error('The sheet could not be rendered');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, element.width, element.height);
  return { context, element };
}

/** An image of the given part of the sheet, as on screen, for "PNG image". */
export async function viewportPage(draw: Draw, viewport: Viewport) {
  const frame = await draw(viewport);
  const { context, element } = canvas(viewport.width, viewport.height);
  paintDisplayList(context, frame, SCALE);
  return canvasPage(element, viewport.width, viewport.height);
}

interface Band {
  cut: ReturnType<typeof pageCut>;
  start: number;
}

/** Page bands along one axis, each starting where the last one's scrolled tracks ended. */
async function bands(
  edgesAt: (start: number) => Promise<readonly number[]>,
  frozen: number,
  limit: number,
  extent: number
): Promise<Band[]> {
  const result: Band[] = [];
  // One past the cap, to tell whether the sheet goes on.
  for (let start = 0; result.length <= MAX_PAGES; ) {
    const cut = pageCut(await edgesAt(start), frozen, limit);
    result.push({ cut, start });
    start += cut.advance;
    if (!cut.advance || start + cut.frozen >= extent) break;
  }
  return result;
}

/** Whether a page shows cell or chart text beyond the repeated frozen titles. */
export function hasText(
  frame: DisplayList,
  rows: Band['cut'],
  columns: Band['cut']
) {
  return frame.commands.some((command) => {
    if (command.op !== 'text' || command.ghost || !command.text.trim())
      return false;
    const x = command.clip?.x ?? command.x;
    const y = command.clip?.y ?? command.y;
    return (
      x >= columns.frozen &&
      x < columns.size &&
      y >= rows.frozen &&
      y < rows.size
    );
  });
}

/**
 * The right edge of the column holding a frame's rightmost cell text (by its
 * anchor, so text overflowing into empty neighbours does not widen the print),
 * 0 without text.
 */
export function textRight(frame: DisplayList) {
  const edges = frame.grid?.colOffsets ?? [];
  let right = 0;
  for (const command of frame.commands) {
    if (command.op !== 'text' || command.ghost || !command.text.trim())
      continue;
    const edge = edges.find((offset) => offset > command.x + 0.5);
    right = Math.max(right, edge ?? command.x);
  }
  return right;
}

/** Rows scanned per call when measuring the printed width. */
const SCAN_HEIGHT = 2000;
/** A bound on the width scan for a sheet with near endless formatted rows. */
const MAX_SCANS = 1000;

/**
 * The active sheet as A4 pages for printing, fit to width as Google Sheets
 * prints: the columns up to the rightmost text scale down to the page width,
 * the rows run down the pages ending at a row edge, frozen rows repeat as
 * titles, and trailing pages without text (formatted but empty rows) are left
 * out. At most MAX_PAGES pages, `truncated` when text goes on past them.
 */
export async function sheetPages(
  draw: Draw,
  extent: Extent
): Promise<{ pages: OfficeRenderedPage[]; truncated: boolean }> {
  // The width covers every row the pages print: as wider text scales the
  // pages down, they reach further, so the scan does too.
  let right = 0;
  const printed = () =>
    (MAX_PAGES * INNER.height) /
    Math.min(1, INNER.width / (right || INNER.width));
  for (
    let y = 0, scanned = 0;
    scanned < MAX_SCANS && y < Math.min(extent.contentHeight, printed());
    scanned++
  ) {
    const frame = await draw({
      height: SCAN_HEIGHT,
      width: extent.contentWidth,
      x: 0,
      y,
    });
    right = Math.max(right, textRight(frame));
    const cut = pageCut(
      frame.grid?.rowOffsets ?? [],
      extent.frozenRows,
      SCAN_HEIGHT
    );
    y += cut.advance;
    if (!cut.advance || y + cut.frozen >= extent.contentHeight) break;
  }
  const width = right || extent.contentWidth;
  const scale = Math.min(1, INNER.width / width);
  const height = INNER.height / scale;
  const page = async (y: number) => draw({ height, width, x: 0, y });
  const columns = pageCut([], 0, width);
  const rows = await bands(
    async (y) => (await page(y)).grid?.rowOffsets ?? [],
    extent.frozenRows,
    height,
    extent.contentHeight
  );
  let last = 0;
  for (const [index, row] of rows.entries())
    if (hasText(await page(row.start), row.cut, columns)) last = index;
  const pages: OfficeRenderedPage[] = [];
  for (const row of rows.slice(0, Math.min(last + 1, MAX_PAGES))) {
    const { context, element } = canvas(PAGE.width, PAGE.height);
    const margin = PAGE.margin * SCALE;
    context.save();
    context.beginPath();
    context.rect(
      margin,
      margin,
      width * scale * SCALE,
      row.cut.size * scale * SCALE
    );
    context.clip();
    paintDisplayList(context, await page(row.start), SCALE * scale, {
      x: margin,
      y: margin,
    });
    context.restore();
    pages.push(await canvasPage(element, PAGE.width, PAGE.height));
    element.width = 0;
    element.height = 0;
  }
  return { pages, truncated: last >= MAX_PAGES };
}
