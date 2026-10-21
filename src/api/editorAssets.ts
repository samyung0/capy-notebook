import { fitImage } from '@/lib/fitImage';
import { api } from './client';
import { materialQuery } from './hooks';
import { queryClient } from './queryClient';
import { uploadWithTicket } from './uploadTurn';

/** A note's media are images and audio only (Epo 2026-10-15). */
export type EditorAssetPurpose = 'image' | 'audio';

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

/** The plan image cap of the account paying for the material's assets. The
 * editors already hold the material, so this reads the cache. */
export async function editorImageMaxBytes(materialId: string) {
  const { imageMaxBytes } = await queryClient.ensureQueryData(
    materialQuery(materialId)
  );
  return imageMaxBytes;
}

// Streams the file through the gateway once its ticket's turn comes, and the
// gateway stores it and returns only stable metadata (Epo 2026-10-22). Plate documents should persist assetId,
// never a resolved short-lived URL. An image over the plan cap is shrunk first.
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
  const metadata = {
    contentType: file.type,
    name: file.name,
    purpose,
    sizeBytes: file.size,
  };
  return uploadWithTicket(
    uploadsPath(materialId),
    metadata,
    (path) => {
      // The metadata part comes first: the gateway reserves storage from it
      // before it reads the file part.
      const form = new FormData();
      form.append('metadata', JSON.stringify(metadata));
      form.append('file', file);
      return api.upload<EditorAsset>(
        path,
        form,
        options.onProgress,
        options.signal
      );
    },
    { signal: options.signal }
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
