import type { EditorAsset, EditorAssetPurpose } from '@/api/editorAssets';

const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm']);

export const MEDIA_ACCEPT: Record<EditorAssetPurpose, string> = {
  audio: 'audio/*',
  file: '*/*',
  image: 'image/*',
  pdf: 'application/pdf',
};

export function editorAssetPurpose(
  file: Pick<File, 'type' | 'name'>
): EditorAssetPurpose {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  if (
    file.type === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf')
  )
    return 'pdf';
  return 'file';
}

export function isVideoFile(file: Pick<File, 'type' | 'name'>) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return (
    file.type.startsWith('video/') || VIDEO_EXTENSIONS.has(extension ?? '')
  );
}

export function plateMediaType(
  purpose: EditorAssetPurpose
): 'img' | 'audio' | 'file' {
  return purpose === 'image' ? 'img' : purpose === 'audio' ? purpose : 'file';
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
  return (
    !isVideoFile(file) &&
    (purpose === 'file' || editorAssetPurpose(file) === purpose)
  );
}
