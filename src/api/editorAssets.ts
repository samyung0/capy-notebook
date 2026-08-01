import { api } from './client';

export type EditorAssetPurpose = 'image' | 'audio' | 'pdf' | 'file';

export interface EditorAsset {
  assetId: string;
  completedAt?: string;
  contentType: string;
  createdAt: string;
  name: string;
  purpose: EditorAssetPurpose;
  sizeBytes: number;
  status: 'ready';
  workspaceId: string;
}

export interface EditorAssetReservation {
  assetId: string;
  expiresAt: string;
  headers: Record<string, string>;
  method: 'PUT';
  uploadId: string;
  url: string;
}

export interface ResolvedEditorAsset {
  assetId: string;
  contentType: string;
  expiresAt: string;
  name: string;
  purpose: EditorAssetPurpose;
  sizeBytes: number;
  url: string;
}

export interface EditorAssetUploadOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export function reserveEditorAsset(
  workspaceId: string,
  file: File,
  purpose: EditorAssetPurpose,
  options: Pick<EditorAssetUploadOptions, 'signal'> = {}
) {
  return api.post<EditorAssetReservation>(
    `/workspaces/${encodeURIComponent(workspaceId)}/editor-assets/uploads`,
    {
      contentType: file.type,
      name: file.name,
      purpose,
      sizeBytes: file.size,
    },
    { signal: options.signal }
  );
}

export function uploadReservedEditorAsset(
  reservation: EditorAssetReservation,
  file: File,
  options: EditorAssetUploadOptions = {}
) {
  if (reservation.method !== 'PUT') {
    throw new Error(
      `Unsupported editor asset upload method: ${reservation.method}`
    );
  }
  return api.putFile(
    reservation.url,
    file,
    reservation.headers,
    options.onProgress,
    options.signal
  );
}

export function completeEditorAssetUpload(
  workspaceId: string,
  uploadId: string,
  signal?: AbortSignal
) {
  return api.post<EditorAsset>(
    `/workspaces/${encodeURIComponent(workspaceId)}/editor-assets/uploads/${encodeURIComponent(uploadId)}/complete`,
    undefined,
    { signal }
  );
}

// Returns only stable metadata. Plate documents should persist assetId, never
// the reservation URL or a resolved short-lived URL.
export async function uploadEditorAsset(
  workspaceId: string,
  file: File,
  purpose: EditorAssetPurpose,
  options: EditorAssetUploadOptions = {}
): Promise<EditorAsset> {
  const reservation = await reserveEditorAsset(
    workspaceId,
    file,
    purpose,
    options
  );
  await uploadReservedEditorAsset(reservation, file, options);
  return completeEditorAssetUpload(
    workspaceId,
    reservation.uploadId,
    options.signal
  );
}

// Resolve at render/download time. Callers must not persist or cache the URL.
export function resolveEditorAsset(assetId: string, signal?: AbortSignal) {
  return api.get<ResolvedEditorAsset>(
    `/editor-assets/${encodeURIComponent(assetId)}/resolve`,
    {
      signal,
    }
  );
}
