import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { m } from '@/i18n';
import { describeError } from '@/lib/errors';
import { isUnavailableWorkspaceInviteError } from './WorkspaceInviteAccept';

describe('workspace invite acceptance errors', () => {
  it.each([401, 403, 404])(
    'uses the non-disclosing unavailable screen for HTTP %s',
    (status) => {
      expect(
        isUnavailableWorkspaceInviteError(new ApiError(status, 'Unavailable'))
      ).toBe(true);
    }
  );

  it.each([
    new ApiError(500, 'Internal Server Error'),
    new ApiError(503, 'Service Unavailable'),
    new TypeError('Failed to fetch'),
  ])('keeps %s retryable on the invitation screen', (error) => {
    expect(isUnavailableWorkspaceInviteError(error)).toBe(false);
  });

  it('tells a frozen recipient about their own account instead of hiding the workspace', () => {
    const frozen = new ApiError(403, 'Forbidden', undefined, {
      code: 'account_over_quota',
    });
    expect(isUnavailableWorkspaceInviteError(frozen)).toBe(false);
    expect(describeError(frozen).title).toBe(m.account_banner_frozen_title());
  });
});
