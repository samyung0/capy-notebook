import { beforeEach, expect, it, vi } from 'vitest';
import { m } from '@/i18n';

const MiB = 1_048_576;
const { ensureQueryData, uploadWithTicket } = vi.hoisted(() => ({
  ensureQueryData: vi.fn(),
  uploadWithTicket: vi.fn(),
}));
vi.mock('./queryClient', () => ({ queryClient: { ensureQueryData } }));
vi.mock('./uploadTurn', () => ({ uploadWithTicket }));
vi.mock('@/lib/fitImageOffThread', () => ({
  fitImageOffThread: async (file: File) => file,
}));

import { uploadEditorAsset } from './editorAssets';

const sized = (bytes: number, name: string, type: string) =>
  new File([new Uint8Array(bytes)], name, { type });

beforeEach(() => {
  vi.resetAllMocks();
  ensureQueryData.mockResolvedValue({
    audioMaxBytes: 2 * MiB,
    imageMaxBytes: MiB,
  });
  uploadWithTicket.mockResolvedValue({ assetId: 'asset_1' });
});

// The browser checks the payer's per-file cap before it uploads (Epo
// 2026-10-22): a file over it is refused, naming the limit, without a ticket.
it('refuses a file over the payer cap without asking for a ticket', async () => {
  await expect(
    uploadEditorAsset(
      'm_1',
      sized(2 * MiB + 1, 'talk.mp3', 'audio/mpeg'),
      'audio'
    )
  ).rejects.toThrow(m.editor_import_too_large({ mb: 2 }));
  await expect(
    uploadEditorAsset('m_1', sized(MiB + 1, 'figure.gif', 'image/gif'), 'image')
  ).rejects.toThrow(m.editor_import_too_large({ mb: 1 }));
  expect(uploadWithTicket).not.toHaveBeenCalled();
});

it('uploads a file at the payer cap', async () => {
  await expect(
    uploadEditorAsset('m_1', sized(2 * MiB, 'talk.mp3', 'audio/mpeg'), 'audio')
  ).resolves.toEqual({ assetId: 'asset_1' });
  expect(uploadWithTicket).toHaveBeenCalledWith(
    '/materials/m_1/editor-assets/uploads',
    {
      contentType: 'audio/mpeg',
      name: 'talk.mp3',
      purpose: 'audio',
      sizeBytes: 2 * MiB,
    },
    expect.any(Function),
    { signal: undefined }
  );
});
