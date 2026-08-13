import { describe, expect, it } from 'vitest';
import { m } from '@/i18n';
import {
  COLUMN_LAYOUTS,
  getCodeBlockLanguageLabel,
  normalizeCalloutVariant,
} from './richBlockConfig';

describe('rich block configuration', () => {
  it('falls back legacy and missing callout variants to info', () => {
    expect(normalizeCalloutVariant(undefined)).toBe('info');
    expect(normalizeCalloutVariant('note')).toBe('info');
    expect(normalizeCalloutVariant('danger')).toBe('danger');
  });

  it('defines the four requested column layouts with complete widths', () => {
    expect(COLUMN_LAYOUTS.map((layout) => layout.value)).toEqual([
      'equal-2',
      'equal-3',
      'left-wide',
      'right-wide',
    ]);
    for (const layout of COLUMN_LAYOUTS) {
      const total = layout.widths.reduce(
        (sum, width) => sum + Number.parseFloat(width),
        0
      );
      expect(total).toBeCloseTo(100, 3);
    }
  });

  it('labels supported code languages for the block toolbar', () => {
    expect(getCodeBlockLanguageLabel('typescript')).toBe('TypeScript');
    expect(getCodeBlockLanguageLabel('')).toBe(m.editor_code_plain_text());
    expect(getCodeBlockLanguageLabel('custom-lang')).toBe('custom-lang');
  });
});
