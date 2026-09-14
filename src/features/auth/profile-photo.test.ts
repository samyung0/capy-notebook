import { describe, expect, it } from 'vitest';
import { PROFILE_PHOTO_MAX_BYTES, profilePhotoError } from './profile-photo';

describe('profile photo validation', () => {
  it('accepts the supported formats at Clerk’s exact byte limit', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(
        profilePhotoError({ size: PROFILE_PHOTO_MAX_BYTES, type })
      ).toBeUndefined();
    }
    expect(
      profilePhotoError({
        size: PROFILE_PHOTO_MAX_BYTES + 1,
        type: 'image/png',
      })
    ).toBe('size');
  });
  it('rejects unsupported files even when chosen outside the input accept filter', () => {
    for (const type of ['image/svg+xml', 'image/gif', 'text/plain', '']) {
      expect(profilePhotoError({ size: 100, type })).toBe('type');
    }
  });
});
