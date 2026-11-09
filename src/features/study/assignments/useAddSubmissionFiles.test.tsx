import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { getLocale } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const upload = vi.hoisted(() => vi.fn());
const compress = vi.hoisted(() => vi.fn());
vi.mock('@/api/hooks', () => ({
  useSourceUploadPolicy: () => ({
    data: {
      imageMaxBytes: 2 << 20,
      kinds: [
        { extensions: ['.jpg'], kind: 'image' },
        { extensions: ['.pdf'], kind: 'pdf' },
      ],
      maxBytes: 10 << 20,
    },
  }),
  useUploadSource: () => ({ mutateAsync: upload }),
}));
vi.mock('@/features/workspace/sourceCompress', () => ({
  compressSource: compress,
}));
vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));

const { createRoot } = await import('react-dom/client');
const { useAddSubmissionFiles } = await import('./useAddSubmissionFiles');

// Finding 3: a phone photo is compressed to the image caps before its upload,
// as any upload's is; a PDF goes as picked.
it('compresses a photo before it joins the paper', async () => {
  const shrunk = new File(['small'], 'photo.jpg', { type: 'image/jpeg' });
  compress.mockResolvedValue({ file: shrunk, removed: 0 });
  upload.mockResolvedValue({});
  let add: ReturnType<typeof useAddSubmissionFiles>['add'] = async () => {};
  function Probe() {
    add = useAddSubmissionFiles({ attemptId: 'at1' }).add;
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<Probe />));
  const photo = new File(['a big photo'], 'photo.jpg', { type: 'image/jpeg' });
  const pdf = new File(['%PDF'], 'paper.pdf', { type: 'application/pdf' });
  await act(() => add([photo, pdf]));
  expect(compress).toHaveBeenCalledTimes(1);
  expect(compress.mock.calls[0][0]).toMatchObject({
    compression: 'image',
    file: photo,
    imageMaxBytes: 2 << 20,
    maxBytes: 10 << 20,
  });
  expect(upload.mock.calls.map(([body]) => body.file)).toEqual([shrunk, pdf]);
  expect(upload.mock.calls[0][0]).toMatchObject({
    attemptId: 'at1',
    batchTotal: 2,
    kind: 'image',
  });
  act(() => root.unmount());
});
