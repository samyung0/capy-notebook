import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { useEffect } from 'react';
import { expect, it, vi } from 'vitest';
import { getLocale } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div><div id="actions"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const read = vi.hoisted(() => ({
  data: undefined as unknown,
  isPending: true,
}));
const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/api/hooks', () => ({
  materialTokenQuery: (id: string) => ({
    queryFn: async () => ({ access: 'write' }),
    queryKey: ['material', id, 'collaboration-token'],
  }),
  useMaterial: () => ({ ...read, error: null, refetch: vi.fn() }),
  useMe: () => ({ data: { id: 'u_1' } }),
}));
vi.mock('@/features/collaboration/deviceCopy', async (original) => ({
  ...(await original<typeof import('@/features/collaboration/deviceCopy')>()),
  useMaterialCopy: () => null,
  useRoomSeed: () => ({ row: { kind: 'note' } }),
}));
vi.mock('./NoteBody', async (original) => ({
  ...(await original<typeof import('./NoteBody')>()),
  NoteBody: () => {
    useEffect(() => {
      mounts.count += 1;
    }, []);
    return null;
  },
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MaterialContent } = await import('./CenterContent');
const { FileActionsTarget } = await import('@/features/files/fileModeContext');

// A note is painted once (Epo 2026-11-04): the paint from a device copy stays, DOM
// and all, as the read answers, with the header's Preview button or without.
it('keeps the paint from a device copy when the read answers', async () => {
  const root = createRoot(document.getElementById('root') as never);
  const render = () =>
    act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <FileActionsTarget.Provider
            value={document.getElementById('actions') as never}
          >
            <MaterialContent
              allowExternalAssets={false}
              centerQuiz={false}
              forceReadOnly={false}
              kind="note"
              materialId="m_1"
              onEditorStatusChange={() => {}}
            />
          </FileActionsTarget.Provider>
        </QueryClientProvider>
      );
    });
  await render();
  expect(mounts.count).toBe(1);

  read.isPending = false;
  read.data = {
    capabilities: { canEdit: true, canEditContent: true },
    content: null,
    id: 'm_1',
    kind: 'note',
    title: 'Note',
  };
  await render();
  expect(mounts.count).toBe(1);
  await act(async () => root.unmount());
});
