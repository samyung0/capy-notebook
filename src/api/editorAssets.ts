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

// Returns only stable metadata. Plate documents should persist assetId, never
// the reservation URL or a resolved short-lived URL.
export async function uploadEditorAsset(
  materialId: string,
  file: File,
  purpose: EditorAssetPurpose,
  options: EditorAssetUploadOptions = {}
): Promise<EditorAsset> {
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

/** One entry per requested id, in order: `assetId` equal to `sourceId` means
 * the note already owns it, another id is the note's own copy, none means it
 * is gone or unreadable. */
export interface AdoptedEditorAsset {
  assetId?: string;
  sourceId: string;
}

/** Make assets (1–50 distinct ids) the note's own, copying another note's.
 * The whole call fails when the copies do not fit the quota. */
export function adoptEditorAssets(materialId: string, assetIds: string[]) {
  return api.post<{ assets: AdoptedEditorAsset[] }>(
    `/materials/${encodeURIComponent(materialId)}/editor-assets/adopt`,
    { assetIds }
  );
}
