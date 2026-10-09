import { fitImage } from '@/lib/fitImage';
import { api } from './client';
import { materialQuery } from './hooks';
import { queryClient } from './queryClient';

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
  /** The material the asset belongs to; a note's own images name it. */
  materialId?: string;
  name: string;
  purpose: EditorAssetPurpose;
  sizeBytes: number;
  url: string;
}

/** A workspace material's assets belong to (and bill) the workspace owner; a
 * standalone material's belong to its owner. The server picks the scope. */
const uploadsPath = (materialId: string) =>
  `/materials/${encodeURIComponent(materialId)}/editor-assets/uploads`;

export interface EditorAssetUploadOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export function reserveEditorAsset(
  materialId: string,
  file: File,
  purpose: EditorAssetPurpose,
  options: Pick<EditorAssetUploadOptions, 'signal'> = {}
) {
  return api.post<EditorAssetReservation>(
    uploadsPath(materialId),
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
  materialId: string,
  uploadId: string,
  signal?: AbortSignal
) {
  return api.post<EditorAsset>(
    `${uploadsPath(materialId)}/${encodeURIComponent(uploadId)}/complete`,
    undefined,
    { signal }
  );
}

/** The plan image cap of the account paying for the material's assets. The
 * editors already hold the material, so this reads the cache. */
export async function editorImageMaxBytes(materialId: string) {
  const { imageMaxBytes } = await queryClient.ensureQueryData(
    materialQuery(materialId)
  );
  return imageMaxBytes;
}

// Returns only stable metadata. Plate documents should persist assetId, never
// the reservation URL or a resolved short-lived URL. An image over the plan
// cap is shrunk first.
export async function uploadEditorAsset(
  materialId: string,
  picked: File,
  purpose: EditorAssetPurpose,
  options: EditorAssetUploadOptions = {}
): Promise<EditorAsset> {
  const file =
    purpose === 'image'
      ? await fitImage(picked, await editorImageMaxBytes(materialId))
      : picked;
  const reservation = await reserveEditorAsset(
    materialId,
    file,
    purpose,
    options
  );
  await uploadReservedEditorAsset(reservation, file, options);
  return completeEditorAssetUpload(
    materialId,
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
