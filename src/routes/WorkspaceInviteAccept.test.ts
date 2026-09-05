import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
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
});
