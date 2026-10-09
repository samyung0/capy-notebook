// Our own pick limit: the editor crops to 512 px, so this only bounds the
// browser's decode memory. Capy offers PNG, JPEG, and WebP uploads.
export const PROFILE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const PROFILE_PHOTO_ACCEPT = 'image/png,image/jpeg,image/webp';

export function profilePhotoError(
  file: Pick<File, 'type' | 'size'>
): 'type' | 'size' | undefined {
  if (!PROFILE_PHOTO_ACCEPT.split(',').includes(file.type)) return 'type';
  if (file.size > PROFILE_PHOTO_MAX_BYTES) return 'size';
}
