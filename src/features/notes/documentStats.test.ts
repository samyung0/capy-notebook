import { describe, expect, it } from 'vitest';
import { MATERIAL_DOCUMENT_LIMITS } from '@/features/materials/document';
import {
  contentSizeKilobytes,
  formatContentSize,
  shouldShowDocumentStats,
} from './documentStats';

const belowHalf = {
  maxDepth: MATERIAL_DOCUMENT_LIMITS.maxDepth / 2 - 1,
  nodeCount: MATERIAL_DOCUMENT_LIMITS.maxNodes / 2 - 1,
};

describe('document statistics visibility', () => {
  it('stays hidden while every dimension is below half', () => {
    expect(
      shouldShowDocumentStats(
        belowHalf,
        MATERIAL_DOCUMENT_LIMITS.maxContentBytes / 2 - 1
      )
    ).toBe(false);
  });

  it('shows at exactly half of the node limit', () => {
    expect(
      shouldShowDocumentStats(
        { ...belowHalf, nodeCount: MATERIAL_DOCUMENT_LIMITS.maxNodes / 2 },
        MATERIAL_DOCUMENT_LIMITS.maxContentBytes / 2 - 1
      )
    ).toBe(true);
  });

  it('shows at exactly half of the depth limit', () => {
    expect(
      shouldShowDocumentStats(
        { ...belowHalf, maxDepth: MATERIAL_DOCUMENT_LIMITS.maxDepth / 2 },
        MATERIAL_DOCUMENT_LIMITS.maxContentBytes / 2 - 1
      )
    ).toBe(true);
  });

  it('shows at exactly half of the saved content-size limit', () => {
    expect(
      shouldShowDocumentStats(
        belowHalf,
        MATERIAL_DOCUMENT_LIMITS.maxContentBytes / 2
      )
    ).toBe(true);
  });

  it('does not show solely because an unsaved size is unavailable', () => {
    expect(shouldShowDocumentStats(belowHalf, null)).toBe(false);
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
