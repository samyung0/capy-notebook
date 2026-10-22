import { m } from '@/i18n';
import { CopyError } from '@/lib/errors';
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

/** The plan cap, by purpose, of the account paying for the material's
 * assets. The editors already hold the material, so this reads the cache. */
async function editorAssetMaxBytes(
  materialId: string,
  purpose: EditorAssetPurpose
) {
  const { audioMaxBytes, imageMaxBytes } = await queryClient.ensureQueryData(
    materialQuery(materialId)
  );
  return purpose === 'image' ? imageMaxBytes : audioMaxBytes;
}

/** The plan image cap of the account paying for the material's assets. */
export function editorImageMaxBytes(materialId: string) {
  return editorAssetMaxBytes(materialId, 'image');
}

// Streams the file through the gateway once its ticket's turn comes, and the
// gateway stores it and returns only stable metadata (Epo 2026-10-22). Plate
// documents should persist assetId, never a resolved short-lived URL. An
// image over the plan cap is shrunk first; a file still over it is refused
// before anything is sent (Epo 2026-10-22), naming the limit. The gateway
// checks the cap again.
export async function uploadEditorAsset(
  materialId: string,
  picked: File,
  purpose: EditorAssetPurpose,
  options: EditorAssetUploadOptions = {}
): Promise<EditorAsset> {
  const maxBytes = await editorAssetMaxBytes(materialId, purpose);
  const file = purpose === 'image' ? await fitImage(picked, maxBytes) : picked;
  if (file.size > maxBytes)
    throw new CopyError(
      m.editor_import_too_large({ mb: Math.round(maxBytes / 1024 / 1024) })
    );
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
