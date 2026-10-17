import { MAX_SCROLL_EXTENT_PX } from '@betteroffice/xlsx/viewer';
import { expect, it } from 'vitest';
import { nameBoxTarget, revealedExtent, scrollSize } from './xlsxNameBox';

const SHEETS = ['Budget', 'Sheet 2', "Bob's"];

it('reads a cell address on the active sheet or another, a range going to its first cell', () => {
  expect(nameBoxTarget('c200', SHEETS, 0)).toEqual({
    cell: { col: 2, row: 199 },
    sheet: 0,
  });
  expect(nameBoxTarget(' $B$7 ', SHEETS, 2)).toEqual({
    cell: { col: 1, row: 6 },
    sheet: 2,
  });
  expect(nameBoxTarget("'sheet 2'!B3:C4", SHEETS, 0)).toEqual({
    cell: { col: 1, row: 2 },
    sheet: 1,
  });
  expect(nameBoxTarget("'Bob''s'!XFD1048576", SHEETS, 0)).toEqual({
    cell: { col: 16_383, row: 1_048_575 },
    sheet: 2,
  });
});

it('names no cell for text, an unknown sheet or an address past the sheet', () => {
  expect(nameBoxTarget('nowhere', SHEETS, 0)).toBeNull();
  expect(nameBoxTarget('Missing!A1', SHEETS, 0)).toBeNull();
  expect(nameBoxTarget('XFE1', SHEETS, 0)).toBeNull();
  expect(nameBoxTarget('A1048577', SHEETS, 0)).toBeNull();
  expect(nameBoxTarget('', SHEETS, 0)).toBeNull();
});

it('grows the scroll area to a far cell but never past the browser size limit', () => {
  const view = { height: 600, width: 800 };
  const far = revealedExtent(
    { height: 1260, width: 500 },
    { x: 128, y: 3980 },
    view
  );
  expect(scrollSize(far, 1)).toEqual({ height: 4580, width: 928 });
  // XFD1048576 at 20 px rows and 64 px columns, at 100% and 200%.
  const last = revealedExtent(far, { x: 1_048_512, y: 20_971_500 }, view);
  expect(scrollSize(last, 1)).toEqual({
    height: MAX_SCROLL_EXTENT_PX,
    width: 1_049_312,
  });
  expect(scrollSize(last, 2).height).toBe(MAX_SCROLL_EXTENT_PX);
});
