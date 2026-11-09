import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const upload = vi.hoisted(() => vi.fn());
const compress = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
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
vi.mock('@/components/ui/userToast', () => ({ userToast: toast }));
// The normal upload's browser analysis, by file name: a PDF opens unless a
// test names why it can't.
const refused = vi.hoisted(() => new Map<string, string>());
vi.mock('@/features/workspace/sourceAnalysis', async (original) => {
  const actual =
    await original<typeof import('@/features/workspace/sourceAnalysis')>();
  return {
    ...actual,
    localSourceAnalysisInput: (file: File) =>
      file.name.endsWith('.pdf') ? { key: file.name, name: file.name } : null,
    SourceAnalysisQueue: class {
      enqueue({ input }: { input: { name: string } }) {
        const code = refused.get(input.name);
        return {
          cancel: () => undefined,
          promise: code
            ? Promise.reject(
                new actual.SourceAnalysisError(
                  code as 'password_protected' | 'unreadable',
                  code
                )
              )
            : Promise.resolve({}),
        };
      }
      dispose() {}
    },
  };
});

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

// Q728 A: once the member's storage is full a hand-in file is refused, and the
// refusal says so with the Marked Upload file refusal's message.
it("says a full account's hand-in file was refused", async () => {
  upload.mockRejectedValue(
    new ApiError(403, 'Forbidden', undefined, {
      code: 'storage_quota_exceeded',
      ownerUserId: 'u_me',
    })
  );
  let add: ReturnType<typeof useAddSubmissionFiles>['add'] = async () => {};
  function Probe() {
    add = useAddSubmissionFiles({ handInId: 'as1' }).add;
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<Probe />));
  await act(() =>
    add([new File(['%PDF'], 'work.pdf', { type: 'application/pdf' })])
  );
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: m.error_quota_body() })
  );
  act(() => root.unmount());
});

// Q726 A: a password-protected or damaged PDF is refused as it is picked, with
// its own message, and the other picked files still upload.
it('refuses a password-protected and a damaged PDF, uploading the rest', async () => {
  refused.set('locked.pdf', 'password_protected');
  refused.set('broken.pdf', 'unreadable');
  upload.mockReset();
  upload.mockResolvedValue({});
  toast.mockReset();
  let add: ReturnType<typeof useAddSubmissionFiles>['add'] = async () => {};
  function Probe() {
    add = useAddSubmissionFiles({ attemptId: 'at1' }).add;
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<Probe />));
  const pdf = (name: string) =>
    new File(['%PDF'], name, { type: 'application/pdf' });
  const good = pdf('answers.pdf');
  await act(() => add([pdf('locked.pdf'), good, pdf('broken.pdf')]));
  expect(toast.mock.calls.map(([body]) => body.title)).toEqual([
    m.assignment_paper_password(),
    m.assignment_paper_damaged(),
  ]);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(upload.mock.calls[0][0]).toMatchObject({ batchTotal: 1, file: good });
  refused.clear();
  act(() => root.unmount());
});
