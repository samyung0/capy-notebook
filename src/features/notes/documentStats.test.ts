import { describe, expect, it } from 'vitest';
import { MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';
import {
  contentSizeKilobytes,
  formatContentSize,
  shouldShowDocumentStats,
} from './documentStats';

const belowHalf = {
  contentBytes: MATERIAL_DOCUMENT_LIMITS.maxContentBytes / 2 - 1,
  maxDepth: MATERIAL_DOCUMENT_LIMITS.maxDepth / 2 - 1,
  nodeCount: MATERIAL_DOCUMENT_LIMITS.maxNodes / 2 - 1,
};

describe('document statistics visibility', () => {
  it('stays hidden while every dimension is below half of its limit', () => {
    expect(shouldShowDocumentStats(belowHalf)).toBe(false);
  });

  it('stays hidden before the service has reported any statistics', () => {
    expect(shouldShowDocumentStats(null)).toBe(false);
  });

  it('shows once a single dimension crosses half of its limit', () => {
    expect(
      shouldShowDocumentStats({
        ...belowHalf,
        nodeCount: MATERIAL_DOCUMENT_LIMITS.maxNodes / 2,
      })
    ).toBe(true);
  });
});

describe('contentSizeKilobytes', () => {
  it('rounds saved bytes up to the displayed kilobyte', () => {
    expect(contentSizeKilobytes(0)).toBe(0);
    expect(contentSizeKilobytes(1024)).toBe(1);
    expect(contentSizeKilobytes(1025)).toBe(2);
  });

  it('formats an absent saved size without estimating it locally', () => {
    expect(formatContentSize(null)).toBe('—');
    expect(formatContentSize(1025)).toBe('2 KB');
  });
});
