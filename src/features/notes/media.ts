import type { EditorAsset, EditorAssetPurpose } from '@/api/editorAssets';

const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm']);

export const MEDIA_ACCEPT: Record<EditorAssetPurpose, string> = {
  audio: 'audio/*',
  image: 'image/*',
};

/** Undefined for a file a note cannot hold: notes embed images and audio
 * only (Epo 2026-10-15). */
export function editorAssetPurpose(
  file: Pick<File, 'type'>
): EditorAssetPurpose | undefined {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
}

export function isVideoFile(file: Pick<File, 'type' | 'name'>) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return (
    file.type.startsWith('video/') || VIDEO_EXTENSIONS.has(extension ?? '')
  );
}

export function plateMediaType(purpose: EditorAssetPurpose): 'img' | 'audio' {
  return purpose === 'image' ? 'img' : 'audio';
}

/** Stable persisted representation. Signed URLs and local blob URLs never
 * cross this boundary. */
export function mediaNodeFromAsset(asset: EditorAsset) {
  return {
    assetId: asset.assetId,
    children: [{ text: '' }],
    contentType: asset.contentType,
    id: asset.assetId,
    name: asset.name,
    sizeBytes: asset.sizeBytes,
    type: plateMediaType(asset.purpose),
  };
}

export function acceptsPurpose(
  file: Pick<File, 'type' | 'name'>,
  purpose: EditorAssetPurpose
) {
  return !isVideoFile(file) && editorAssetPurpose(file) === purpose;
}
