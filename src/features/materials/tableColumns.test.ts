import type { TTableElement } from 'platejs';
import { describe, expect, it } from 'vitest';
import { tableColumnWidths } from './tableColumns';

const cell = (
  text: string,
  spans: { colSpan?: number; rowSpan?: number } = {}
) => ({
  children: [{ children: [{ text }], type: 'p' }],
  type: 'td',
  ...spans,
});
const row = (...cells: ReturnType<typeof cell>[]) => ({
  children: cells,
  type: 'tr',
});
const table = (rows: ReturnType<typeof row>[], colSizes?: number[]) =>
  ({ children: rows, colSizes, type: 'table' }) as unknown as TTableElement;

describe('tableColumnWidths', () => {
  it('fits each column to its longest line within the min and max', () => {
    const widths = tableColumnWidths(
      table([
        row(cell('Id'), cell('Twenty characters ab'), cell('x'.repeat(200))),
      ])
    );
    expect(widths).toEqual([90, 180, 320]);
  });

  it('keeps a resized column and ignores merged cells and rows they cover', () => {
    const widths = tableColumnWidths(
      table(
        [
          row(
            cell('x'.repeat(30), { rowSpan: 2 }),
            cell('Twenty characters ab')
          ),
          row(cell('Twenty characters abTwenty characters ab')),
          row(cell('y'.repeat(100), { colSpan: 2 })),
        ],
        [0, 150]
      )
    );
    // Row 2's only cell sits in column 1 (column 0 is covered), so it does
    // not widen column 0; the full-width merged cell widens neither.
    expect(widths).toEqual([255, 150]);
  });
});
