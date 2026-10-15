import { describe, expect, it } from 'vitest';
import {
  CSV_PREVIEW_MAX_COLUMNS,
  CSV_PREVIEW_MAX_ROWS,
  parseCsvPreview,
} from './csvPreviewCore';

const encoder = new TextEncoder();

describe('CSV preview bounds', () => {
  it('parses only the visible row and column window', () => {
    const header = Array.from(
      { length: CSV_PREVIEW_MAX_COLUMNS + 1 },
      (_, index) => `c${index}`
    ).join(',');
    const rows = Array.from(
      { length: CSV_PREVIEW_MAX_ROWS + 1 },
      () => header
    ).join('\n');

    const result = parseCsvPreview(encoder.encode(rows));

    expect(result.rows).toHaveLength(CSV_PREVIEW_MAX_ROWS);
    expect(result.rows[0]).toHaveLength(CSV_PREVIEW_MAX_COLUMNS);
    expect(result.truncated).toBe(true);
  });

  it('keeps cells as written, decodes UTF-8 and measures columns', () => {
    const long = 'x'.repeat(200);
    const result = parseCsvPreview(
      encoder.encode(
        `species,count,notes\nfrog,12,${long}\n蛙蛙蛙蛙蛙蛙蛙蛙蛙蛙,,\n`
      )
    );

    expect(result.rows[1]).toEqual(['frog', '12', long]);
    expect(result.rows[2]).toEqual(['蛙蛙蛙蛙蛙蛙蛙蛙蛙蛙', '', '']);
    expect(result.columns.map((column) => column.numeric)).toEqual([
      false,
      true,
      false,
    ]);
    // 10 CJK characters count double; short and long columns clamp.
    expect(result.columns.map((column) => column.width)).toEqual([
      180, 90, 320,
    ]);
    expect(
      parseCsvPreview(encoder.encode('date,passed\n2026-04-02,TRUE\n')).rows[1]
    ).toEqual(['2026-04-02', 'TRUE']);
  });
});

describe('CSV preview parsing', () => {
  const rows = (text: string) => parseCsvPreview(encoder.encode(text)).rows;

  it('reads quoted fields with delimiters, line breaks and escaped quotes', () => {
    expect(
      rows(
        'id,comment\r\n1,"a, b\r\nnext ""line"""\r\n2,"tab\there"\r\n3,""\r\n'
      )
    ).toEqual([
      ['id', 'comment'],
      ['1', 'a, b\r\nnext "line"'],
      ['2', 'tab\there'],
      ['3', ''],
    ]);
    // A quote inside an unquoted field, or after a closing quote, is text.
    expect(rows('a"b,"c"d\n')).toEqual([['a"b', 'cd']]);
  });

  it('ends records at LF, CRLF or CR', () => {
    expect(rows('a,b\n1,2\r\n3,4\r5,6')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ]);
  });

  it('picks tab when tabs outnumber commas outside quotes', () => {
    expect(rows('name\tnote\nfrog\t"1,2,3"\n')).toEqual([
      ['name', 'note'],
      ['frog', '1,2,3'],
    ]);
    expect(rows('"a\tb\tc",d\n')).toEqual([['a\tb\tc', 'd']]);
  });

  it('drops a BOM and pads ragged rows', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = encoder.encode('name,score\nfrog\nnewt,4,extra\n');
    const bytes = new Uint8Array(bom.length + body.length);
    bytes.set(bom);
    bytes.set(body, bom.length);

    expect(parseCsvPreview(bytes).rows).toEqual([
      ['name', 'score', ''],
      ['frog', '', ''],
      ['newt', '4', 'extra'],
    ]);
  });
});
