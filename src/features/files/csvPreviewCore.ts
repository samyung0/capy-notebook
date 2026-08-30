import * as XLSX from 'xlsx';

export type CsvPreviewCell = boolean | number | string | null;

export const CSV_PREVIEW_MAX_BYTES = 30 * 1024 * 1024;
export const CSV_PREVIEW_MAX_COLUMNS = 50;
export const CSV_PREVIEW_MAX_ROWS = 500;

export interface CsvPreviewResult {
  rows: CsvPreviewCell[][];
  truncated: boolean;
}

export function parseCsvPreview(bytes: Uint8Array): CsvPreviewResult {
  if (bytes.byteLength > CSV_PREVIEW_MAX_BYTES) {
    throw new Error('Delimited file exceeds the preview byte limit');
  }
  const workbook = XLSX.read(bytes, {
    sheetRows: CSV_PREVIEW_MAX_ROWS + 1,
    type: 'array',
  });
  const first = workbook.Sheets[workbook.SheetNames[0] ?? ''];
  const parsed = first
    ? XLSX.utils.sheet_to_json<unknown[]>(first, {
        defval: null,
        header: 1,
      })
    : [];
  const truncated =
    parsed.length > CSV_PREVIEW_MAX_ROWS ||
    parsed.some((row) => row.length > CSV_PREVIEW_MAX_COLUMNS);
  return {
    rows: parsed.slice(0, CSV_PREVIEW_MAX_ROWS).map((row) =>
      row.slice(0, CSV_PREVIEW_MAX_COLUMNS).map((cell) => {
        if (
          cell === null ||
          typeof cell === 'boolean' ||
          typeof cell === 'number' ||
          typeof cell === 'string'
        ) {
          return cell;
        }
        return String(cell);
      })
    ),
    truncated,
  };
}
