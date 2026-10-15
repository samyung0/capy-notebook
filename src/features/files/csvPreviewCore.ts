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

/** Tab when tabs outnumber commas outside quotes in the first KiB, else comma. */
function guessDelimiter(text: string): string {
  let commas = 0;
  let tabs = 0;
  let quoted = false;
  for (const char of text.slice(0, 1024)) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') commas++;
    else if (!quoted && char === '\t') tabs++;
  }
  return tabs > commas ? '\t' : ',';
}

/** RFC 4180 records: a field starting with `"` is quoted, may hold
 *  delimiters and line breaks, and reads `""` as one quote; text after its
 *  closing quote is kept. Records end at CRLF, LF or CR. Stops after
 *  `maxRows` records and keeps `maxColumns + 1` cells per record at most, so
 *  the caller can tell a wider file. */
function parseDelimited(
  text: string,
  delimiter: string,
  maxRows: number,
  maxColumns: number
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  while (rows.length < maxRows) {
    let cell = '';
    if (text[i] === '"') {
      let from = i + 1;
      for (;;) {
        const quote = text.indexOf('"', from);
        if (quote === -1) {
          cell += text.slice(from);
          i = text.length;
          break;
        }
        cell += text.slice(from, quote);
        if (text[quote + 1] !== '"') {
          i = quote + 1;
          break;
        }
        cell += '"';
        from = quote + 2;
      }
    }
    const from = i;
    while (
      i < text.length &&
      text[i] !== delimiter &&
      text[i] !== '\n' &&
      text[i] !== '\r'
    ) {
      i++;
    }
    cell += text.slice(from, i);
    if (row.length <= maxColumns) row.push(cell);
    if (text[i] === delimiter) {
      i++;
      continue;
    }
    rows.push(row);
    row = [];
    i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    if (i >= text.length) break;
  }
  return rows;
}

export function parseCsvPreview(bytes: Uint8Array): CsvPreviewResult {
  if (bytes.byteLength > CSV_PREVIEW_MAX_BYTES) {
    throw new Error('Delimited file exceeds the preview byte limit');
  }
  // TextDecoder drops a UTF-8 BOM. Cells stay as written: no date or
  // boolean coercion.
  const text = new TextDecoder().decode(bytes);
  const records = parseDelimited(
    text,
    guessDelimiter(text),
    CSV_PREVIEW_MAX_ROWS + 1,
    CSV_PREVIEW_MAX_COLUMNS
  );
  const width = Math.max(...records.map((record) => record.length));
  const truncated =
    records.length > CSV_PREVIEW_MAX_ROWS || width > CSV_PREVIEW_MAX_COLUMNS;
  // Ragged rows are padded to the widest one, as a table.
  const columns = Math.min(width, CSV_PREVIEW_MAX_COLUMNS);
  const rows = records
    .slice(0, CSV_PREVIEW_MAX_ROWS)
    .map((record) =>
      Array.from({ length: columns }, (_, index) => record[index] ?? '')
    );
  return { columns: describeColumns(rows), rows, truncated };
}
