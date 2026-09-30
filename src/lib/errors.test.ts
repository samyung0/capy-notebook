import { describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/api/client';
import { m } from '@/i18n';
import {
  deferStorageRefusal,
  describeError,
  errorCopy,
  errorKind,
  handleWorkspaceRefusals,
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
      icon: 'fileError',
      title: m.error_source_changed_title(),
    });
  });

  it('reads any Huma error code and gives it its own copy', async () => {
    const reply = (code: string, status: number) =>
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: 'raw server text',
            errors: [{ message: code }],
            status,
            title: 'Conflict',
          }),
          { status }
        )
      );
    vi.stubGlobal('fetch', reply('revision_conflict', 409));
    const stale = await api.patch('/quizzes/q/content', {}).catch((e) => e);
    vi.stubGlobal('fetch', reply('workspace_limit_exceeded', 403));
    const workspaces = await api.post('/workspaces', {}).catch((e) => e);
    vi.unstubAllGlobals();

    expect(stale).toMatchObject({ code: 'revision_conflict', status: 409 });
    expect(describeError(stale)).toEqual({
      action: 'reload',
      description: m.error_revision_conflict_body(),
      title: m.error_revision_conflict_title(),
    });
    expect(errorCopy(stale, 'fallback')).not.toContain('raw server text');
    expect(describeError(workspaces).title).toBe(
      m.error_workspace_limit_title()
    );
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

describe('frozen and storage refusals inside a workspace', () => {
  const frozen = new ApiError(403, 'Forbidden', undefined, {
    code: 'account_over_quota',
  });

  it('go to the open workspace status, and keep the own-account copy elsewhere', () => {
    expect(deferStorageRefusal(frozen)).toBe(false);
    expect(describeError(frozen).title).toBe(m.account_banner_frozen_title());
    const status = vi.fn();
    const leave = handleWorkspaceRefusals(status, false);
    expect(deferStorageRefusal(new ApiError(500, 'Server Error'))).toBe(false);
    expect(deferStorageRefusal(frozen)).toBe(true);
    // The upload dialog seeing the refusal the mutation cache deferred: the
    // status shows once.
    expect(deferStorageRefusal(frozen)).toBe(true);
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(frozen);
    leave();
    expect(deferStorageRefusal(frozen)).toBe(false);
  });

  it("send a storage refusal to the status, unless it is a member's own quota", () => {
    const status = vi.fn();
    // A member writing into a full owner's workspace gets the code alone.
    const ownerQuota = new ApiError(403, 'Forbidden', undefined, {
      code: 'storage_quota_exceeded',
    });
    // The charged account gets its numbers.
    const ownQuota = () =>
      new ApiError(403, 'Forbidden', undefined, {
        code: 'storage_quota_exceeded',
        ownerUserId: 'u_me',
        storageLimitBytes: 100,
      });
    let leave = handleWorkspaceRefusals(status, false);
    expect(deferStorageRefusal(ownerQuota)).toBe(true);
    // A member's clone is charged to the member: the clone copy shows.
    expect(deferStorageRefusal(ownQuota())).toBe(false);
    leave();
    leave = handleWorkspaceRefusals(status, true);
    const owner = ownQuota();
    expect(deferStorageRefusal(owner)).toBe(true);
    leave();
    expect(status.mock.calls).toEqual([[ownerQuota], [owner]]);
  });
});
