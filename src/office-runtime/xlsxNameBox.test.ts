import { expect, it } from 'vitest';
import { nameBoxTarget, revealedExtent } from './xlsxNameBox';

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

it('grows the scroll area only as far as a view past the cell needs', () => {
  const view = { height: 600, width: 800 };
  expect(
    revealedExtent({ height: 1260, width: 500 }, { x: 128, y: 3980 }, view)
  ).toEqual({ height: 4580, width: 928 });
  expect(
    revealedExtent({ height: 1260, width: 500 }, { x: 0, y: 100 }, view)
  ).toEqual({ height: 1260, width: 800 });
});
