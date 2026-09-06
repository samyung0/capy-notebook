import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { m } from '@/i18n';
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

  it('explains captured source changes as a manually retryable request', () => {
    const error = new ApiError(409, 'Conflict', undefined, {
      code: 'source_changed',
    });
    expect(errorKind(error)).toBe('sourceChanged');
    expect(describeError(error)).toEqual({
      action: 'retry',
      description: m.error_source_changed_body(),
      title: m.error_source_changed_title(),
    });
  });

  it('classifies coded quota failures independently of status', () => {
    const error = new ApiError(403, 'Forbidden', undefined, {
      code: 'storage_quota_exceeded',
    });

    expect(errorKind(error)).toBe('quota');
    expect(describeError(error).action).toBe('subscription');
  });

  it('classifies workspace file-cap failures distinctly from storage quota', () => {
    const error = new ApiError(403, 'Forbidden', undefined, {
      code: 'files_limit_exceeded',
      filesLimit: 100,
    });

    expect(errorKind(error)).toBe('files');
    expect(describeError(error).action).toBeUndefined();
    expect(describeError(error).title).not.toBe(
      describeError(
        new ApiError(403, 'Forbidden', undefined, {
          code: 'storage_quota_exceeded',
        })
      ).title
    );
  });

  it('classifies a rejected BYOK key distinctly from validation', () => {
    const error = new ApiError(400, 'Bad Request', undefined, {
      code: 'invalid_llm_key',
    });

    expect(errorKind(error)).toBe('llmKey');
    expect(describeError(error).description).toBe(
      'The provider rejected this key.'
    );
    expect(describeError(error).title).not.toBe(
      describeError(new ApiError(400, 'Bad Request')).title
    );
  });

  it('classifies an unclear BYOK failure with the double-check copy', () => {
    const error = new ApiError(400, 'Bad Request', undefined, {
      code: 'llm_key_failed',
    });

    expect(errorKind(error)).toBe('llmKey');
    expect(describeError(error).description).toContain(
      'double check if the key is valid'
    );
  });

  it('classifies an unavailable LLM model distinctly from validation', () => {
    const error = new ApiError(422, 'Unprocessable Entity', undefined, {
      code: 'model_unavailable',
    });

    expect(errorKind(error)).toBe('model');
    expect(describeError(error).title).not.toBe(
      describeError(new ApiError(422, 'Unprocessable Entity')).title
    );
  });

  it('classifies exhausted AI credits distinctly from storage quota', () => {
    const error = new ApiError(403, 'Forbidden', undefined, {
      code: 'llm_credits_exhausted',
    });

    expect(errorKind(error)).toBe('credits');
    expect(describeError(error).title).not.toBe(
      describeError(
        new ApiError(403, 'Forbidden', undefined, {
          code: 'storage_quota_exceeded',
        })
      ).title
    );
    expect(isNonDisclosing(error)).toBe(false);
    expect(describeError(error).action).toBe('subscription');
  });

  it('classifies ingest lease exhaustion separately from credit and stream limits', () => {
    const error = new ApiError(429, 'Too Many Requests', undefined, {
      code: 'too_many_ingest_leases',
    });
    expect(errorKind(error)).toBe('ingest');
    expect(describeError(error).title).toBe(m.error_ingest_slots_title());
  });

  it('classifies a busy provider as a retryable, distinct condition', () => {
    const error = new ApiError(503, 'Service Unavailable', undefined, {
      code: 'provider_busy',
      retryAfterSeconds: 5,
    });
    expect(errorKind(error)).toBe('busy');
    expect(describeError(error)).toEqual({
      action: 'retry',
      description: m.error_provider_busy_body(),
      title: m.error_provider_busy_title(),
    });
  });

  it('does not treat programming TypeErrors as network failures', () => {
    const error = new TypeError(
      "Cannot read properties of undefined (reading 'aiChat')"
    );

    expect(errorKind(error)).toBe('unknown');
    expect(describeError(error).title).not.toBe(
      describeError(new TypeError('Failed to fetch')).title
    );
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
