import { estimateColumnWidth } from '@/lib/columnWidth';

export const CSV_PREVIEW_MAX_BYTES = 30 * 1024 * 1024;
export const CSV_PREVIEW_MAX_COLUMNS = 50;
export const CSV_PREVIEW_MAX_ROWS = 500;

const COLUMN_SAMPLE_ROWS = 100;
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

function describeColumns(rows: string[][]): CsvPreviewColumn[] {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const sample = rows.slice(0, COLUMN_SAMPLE_ROWS + 1);
  return Array.from({ length: count }, (_, index) => {
    const body = rows
      .slice(1)
      .map((row) => row[index]?.trim() ?? '')
      .filter(Boolean);
    return {
      numeric:
        body.length > 0 && body.every((cell) => NUMBER_PATTERN.test(cell)),
      width: estimateColumnWidth(sample.map((row) => row[index] ?? '')),
    };
  });
}

// In tie order: the most frequent outside quotes in the first KiB wins.
const DELIMITERS = [',', '\t', ';', '|'];
const SEP_LINE_PATTERN = /^sep=(.)(\r\n|\n|\r|$)/;

/** An Excel `sep=<char>` first line names the delimiter; otherwise the
 *  delimiter is guessed as the previous SheetJS preview did. */
function splitDelimiter(text: string): [string, string] {
  const hint = SEP_LINE_PATTERN.exec(text);
  if (hint) return [hint[1], text.slice(hint[0].length)];
  const counts = new Map(DELIMITERS.map((char) => [char, 0]));
  let quoted = false;
  for (const char of text.slice(0, 1024)) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && counts.has(char)) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
  }
  const delimiter = DELIMITERS.reduce((best, char) =>
    (counts.get(char) ?? 0) > (counts.get(best) ?? 0) ? char : best
  );
  return [delimiter, text];
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
  const [delimiter, text] = splitDelimiter(new TextDecoder().decode(bytes));
  const records = parseDelimited(
    text,
    delimiter,
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
