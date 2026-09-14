export const PROFILE_PHOTO_MAX_BYTES = 10_000_000;
export const PROFILE_PHOTO_ACCEPT = 'image/png,image/jpeg,image/webp';

// Clerk's 10 MB byte limit; Capy offers PNG, JPEG, and WebP uploads.
export function profilePhotoError(
  file: Pick<File, 'type' | 'size'>
): 'type' | 'size' | undefined {
  if (!PROFILE_PHOTO_ACCEPT.split(',').includes(file.type)) return 'type';
  if (file.size > PROFILE_PHOTO_MAX_BYTES) return 'size';
}
