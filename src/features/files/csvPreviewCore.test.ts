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
});
