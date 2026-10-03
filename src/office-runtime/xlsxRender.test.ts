import type { DisplayList } from '@betteroffice/xlsx/viewer';
import { expect, it } from 'vitest';
import { hasText, pageCut, textRight } from './xlsxRender';

it('ends a printed page at the last track edge that fits, past the frozen tracks', () => {
  // Track edges at 0, 30, 60, 100, 150; 120px of page.
  expect(pageCut([0, 30, 60, 100, 150], 0, 120)).toEqual({
    advance: 100,
    frozen: 0,
    size: 100,
  });
  // One frozen track repeats on every page; only the rest moves on.
  expect(pageCut([0, 30, 60, 100, 150], 1, 120)).toEqual({
    advance: 70,
    frozen: 30,
    size: 100,
  });
  // A track taller than the page is cut at the page edge.
  expect(pageCut([0, 500], 0, 120)).toEqual({
    advance: 120,
    frozen: 0,
    size: 120,
  });
});

it('counts a page as printed text only past its repeated frozen titles', () => {
  const text = (x: number, y: number, value = 'Course') => ({
    color: '#000000',
    fontSize: 11,
    op: 'text' as const,
    text: value,
    x,
    y,
  });
  const page = (commands: DisplayList['commands']) =>
    ({ commands, height: 100, width: 100 }) as DisplayList;
  const rows = pageCut([0, 20, 40, 60], 1, 60);
  const columns = pageCut([0, 30, 60], 1, 60);
  // Titles in the frozen row and column only: an empty page.
  expect(
    hasText(page([text(5, 5), text(40, 5), text(5, 30)]), rows, columns)
  ).toBe(false);
  expect(hasText(page([text(40, 30, '  ')]), rows, columns)).toBe(false);
  expect(hasText(page([text(40, 30)]), rows, columns)).toBe(true);
});

it('measures the printed width to the column of the rightmost cell text', () => {
  const page = (commands: DisplayList['commands']) =>
    ({
      commands,
      grid: {
        colOffsets: [0, 100, 180, 400],
        rowOffsets: [0, 20],
        startCol: 0,
        startRow: 0,
      },
      height: 100,
      width: 400,
    }) as DisplayList;
  const text = (x: number, value: string) => ({
    color: '#000000',
    fontSize: 11,
    op: 'text' as const,
    text: value,
    x,
    y: 10,
  });
  expect(textRight(page([]))).toBe(0);
  // Text anchored in the second column, overflowing into the empty third:
  // the print ends with the second column. Blank and ghost text don't count.
  expect(
    textRight(
      page([
        {
          ...text(104, 'A long comment'),
          clip: { h: 20, w: 296, x: 100, y: 0 },
        },
        text(300, '  '),
        { ...text(350, 'ghost'), ghost: true },
      ])
    )
  ).toBe(180);
});
