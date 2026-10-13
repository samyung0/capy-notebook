import * as XLSX from 'xlsx';

export const CSV_PREVIEW_MAX_BYTES = 30 * 1024 * 1024;
export const CSV_PREVIEW_MAX_COLUMNS = 50;
export const CSV_PREVIEW_MAX_ROWS = 500;

/** Column widths are estimated from character counts so the view can use a
 *  fixed table layout: no per-cell measuring, and widths survive sorting. */
const COLUMN_MIN_PX = 90;
const COLUMN_MAX_PX = 320;
const COLUMN_PADDING_PX = 30;
const CHAR_PX = 7.5;
const COLUMN_SAMPLE_ROWS = 100;
// CJK and fullwidth characters render about twice as wide as Latin ones.
const WIDE_CHAR_PATTERN =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;
const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

export interface CsvPreviewColumn {
  /** Every non-empty body cell is a number; right-aligned and sorted numerically. */
  numeric: boolean;
  width: number;
}

export interface CsvPreviewResult {
  columns: CsvPreviewColumn[];
  /** Cells exactly as written in the file; the first row is the header. */
  rows: string[][];
  truncated: boolean;
}

function displayWidth(cell: string): number {
  let width = 0;
  for (const char of cell) width += WIDE_CHAR_PATTERN.test(char) ? 2 : 1;
  return width;
}

function describeColumns(rows: string[][]): CsvPreviewColumn[] {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const sample = rows.slice(0, COLUMN_SAMPLE_ROWS + 1);
  return Array.from({ length: count }, (_, index) => {
    const chars = Math.max(
      ...sample.map((row) => displayWidth(row[index] ?? ''))
    );
    const body = rows
      .slice(1)
      .map((row) => row[index]?.trim() ?? '')
      .filter(Boolean);
    return {
      numeric:
        body.length > 0 && body.every((cell) => NUMBER_PATTERN.test(cell)),
      width: Math.min(
        COLUMN_MAX_PX,
        Math.max(COLUMN_MIN_PX, Math.round(chars * CHAR_PX + COLUMN_PADDING_PX))
      ),
    };
  });
}

export function parseCsvPreview(bytes: Uint8Array): CsvPreviewResult {
  if (bytes.byteLength > CSV_PREVIEW_MAX_BYTES) {
    throw new Error('Delimited file exceeds the preview byte limit');
  }
  // SheetJS reads raw bytes as Latin-1, so decode as UTF-8 (BOM stripped)
  // first. `raw` keeps every cell as written: no date or boolean coercion.
  const workbook = XLSX.read(new TextDecoder().decode(bytes), {
    raw: true,
    sheetRows: CSV_PREVIEW_MAX_ROWS + 1,
    type: 'string',
  });
  const first = workbook.Sheets[workbook.SheetNames[0] ?? ''];
  const parsed = first
    ? XLSX.utils.sheet_to_json<unknown[]>(first, {
        defval: '',
        header: 1,
        raw: false,
      })
    : [];
  const truncated =
    parsed.length > CSV_PREVIEW_MAX_ROWS ||
    parsed.some((row) => row.length > CSV_PREVIEW_MAX_COLUMNS);
  const rows = parsed
    .slice(0, CSV_PREVIEW_MAX_ROWS)
    .map((row) => row.slice(0, CSV_PREVIEW_MAX_COLUMNS).map(String));
  return { columns: describeColumns(rows), rows, truncated };
}
