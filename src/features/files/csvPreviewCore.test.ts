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
