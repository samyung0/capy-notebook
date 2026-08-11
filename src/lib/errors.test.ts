import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import {
  describeError,
  errorKind,
  isAbortError,
  isChunkLoadError,
  isNonDisclosing,
  toastKeyFor,
} from './errors';

describe('frontend error normalization', () => {
  it.each([
    [new ApiError(401, 'Unauthorized'), 'auth'],
    [new ApiError(403, 'Forbidden'), 'forbidden'],
    [new ApiError(404, 'Not Found'), 'notFound'],
    [new ApiError(422, 'Unprocessable Entity'), 'validation'],
    [new ApiError(503, 'Service Unavailable'), 'server'],
    [new TypeError('Failed to fetch'), 'network'],
  ] as const)('classifies %s as %s', (error, kind) => {
    expect(errorKind(error)).toBe(kind);
  });

  it('classifies coded quota failures independently of status', () => {
    const error = new ApiError(403, 'Forbidden', undefined, {
      code: 'storage_quota_exceeded',
    });

    expect(errorKind(error)).toBe('quota');
    expect(describeError(error).action).toBe('subscription');
  });

  it('recognizes dynamic import failures', () => {
    const error = new TypeError(
      'Failed to fetch dynamically imported module: /assets/page.js'
    );

    expect(isChunkLoadError(error)).toBe(true);
    expect(errorKind(error)).toBe('chunkLoad');
    expect(describeError(error).action).toBe('reload');
  });

  it('treats authorization and missing-resource failures as non-disclosing', () => {
    expect(isNonDisclosing(new ApiError(401, 'Unauthorized'))).toBe(true);
    expect(isNonDisclosing(new ApiError(403, 'Forbidden'))).toBe(true);
    expect(isNonDisclosing(new ApiError(404, 'Not Found'))).toBe(true);
    expect(isNonDisclosing(new ApiError(500, 'Server Error'))).toBe(false);
  });

  it('recognizes cancellation and gives equivalent errors the same toast key', () => {
    const cancellation = new DOMException('Cancelled', 'AbortError');

    expect(isAbortError(cancellation)).toBe(true);
    expect(errorKind(cancellation)).toBe('cancelled');
    expect(toastKeyFor(new TypeError('Failed to fetch'))).toBe(
      toastKeyFor(new Error('network error'))
    );
  });
});
