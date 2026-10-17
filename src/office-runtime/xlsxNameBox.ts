import { parseHyperlinkLocation } from '@betteroffice/xlsx/viewer';

/** The sheet and cell a name-box address names (`B7`, `$B$7`, `'Sheet 2'!B7`;
 * a range goes to its first cell), as the editor reads it, or null when it
 * names no cell of this workbook. */
export function nameBoxTarget(
  address: string,
  sheetNames: readonly string[],
  activeSheet: number
) {
  const target = parseHyperlinkLocation(
    address.trim(),
    sheetNames[activeSheet] ?? ''
  );
  if (!target) return null;
  const sheet = sheetNames.findIndex(
    (name) => name.toLowerCase() === target.sheetName.toLowerCase()
  );
  return sheet < 0
    ? null
    : { cell: { col: target.col, row: target.row }, sheet };
}

/** The scroll area grown, as the editor's, until a cell at `position` (sheet
 * pixels) can be scrolled into a view of `view`. */
export function revealedExtent(
  extent: { height: number; width: number },
  position: { x: number; y: number },
  view: { height: number; width: number }
) {
  return {
    height: Math.max(extent.height, position.y + view.height),
    width: Math.max(extent.width, position.x + view.width),
  };
}
