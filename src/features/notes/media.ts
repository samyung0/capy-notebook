import type { EditorAsset, EditorAssetPurpose } from '@/api/editorAssets';

export const MEDIA_ACCEPT: Record<EditorAssetPurpose, string> = {
  audio: 'audio/*',
  file: '*/*',
  image: 'image/*',
  pdf: 'application/pdf',
  video: 'video/*',
};

export function editorAssetPurpose(
  file: Pick<File, 'type' | 'name'>
): EditorAssetPurpose {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/')) return 'video';
  if (
    file.type === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf')
  )
    return 'pdf';
  return 'file';
}

export function plateMediaType(
  purpose: EditorAssetPurpose
): 'img' | 'audio' | 'video' | 'file' {
  return purpose === 'image'
    ? 'img'
    : purpose === 'audio' || purpose === 'video'
      ? purpose
      : 'file';
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
  return purpose === 'file' || editorAssetPurpose(file) === purpose;
}
