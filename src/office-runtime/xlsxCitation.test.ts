import { describe, expect, it } from 'vitest';
import { liveXlsxCitation } from './xlsxCitation';

type Match = {
  a1: string;
  col: number;
  row: number;
  sheet: number;
  sheetId: string;
  sheetName: string;
  text: string;
};

/** The editor's workbook search over `cells`, case-insensitive as the engine's. */
function workbook(cells: Match[]) {
  const searched: string[] = [];
  return {
    handle: {
      searchText: async (query: string, options?: { limit?: number }) => {
        searched.push(query);
        return cells
          .filter((cell) =>
            cell.text.toLowerCase().includes(query.toLowerCase())
          )
          .slice(0, options?.limit);
      },
    },
    searched,
  };
}

const cell = (a1: string, row: number, col: number, text: string): Match => ({
  a1,
  col,
  row,
  sheet: 1,
  sheetId: 'sheet-2',
  sheetName: 'Courses',
  text,
});

// The editor applies View's rule (complete, unique, normalized) to the open
// workbook's current cells.
describe('a citation in the XLSX editor', () => {
  it("finds the one cell holding a wrapped quote, by the quote's longest piece", async () => {
    const { handle, searched } = workbook([
      cell('B3', 2, 1, 'Critical Zones: Our Toxic Environment and Well-Being'),
      cell('B4', 3, 1, 'Environmental Science'),
    ]);
    expect(
      await liveXlsxCitation(
        handle,
        'Critical Zones: Our Toxic\nEnviron-\nment'
      )
    ).toEqual({ address: 'B3', col: 1, row: 2, sheet: 1, sheetId: 'sheet-2' });
    expect(searched).toEqual(['Critical']);
  });

  it('abstains for a quote two cells hold', async () => {
    const text = 'Assessment criteria for the course';
    const { handle } = workbook([
      cell('A1', 0, 0, text),
      cell('A2', 1, 0, text),
    ]);
    expect(await liveXlsxCitation(handle, text)).toBeNull();
  });
});
