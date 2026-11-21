import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ApiError as ApiErrorType } from '@/api/client';

// linkedom's document goes in before react-dom/client loads.
const { document, window } = parseHTML(
  '<!doctype html><html><body></body></html>'
);
Object.assign(globalThis, {
  document,
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  // The messages' runtime keeps the locale there.
  localStorage: { getItem: () => null, setItem: () => undefined },
  Node: window.Node,
  window,
});

/** What each item's read says now: its data, or why it refused. */
const reads: Record<string, { data?: object; error: ApiErrorType | null }> = {};
const read = (id: string) => ({
  ...reads[id],
  isError: !!reads[id].error,
  isLoading: false,
  isPending: false,
  refetch: vi.fn(),
});
vi.mock('@/api/hooks', () => ({
  useFile: read,
  useMaterial: read,
  // No one signed in: nothing of this device's is read or written.
  useMe: () => ({ data: undefined }),
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/lib/sourceCache', async (original) => ({
  ...(await original<typeof import('@/lib/sourceCache')>()),
  dropDeviceCopies: vi.fn(async () => undefined),
}));
vi.mock('@/features/collaboration/deviceCopy', async (original) => ({
  ...(await original<typeof import('@/features/collaboration/deviceCopy')>()),
  dropDeletedCopies: vi.fn(async () => undefined),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { ApiError, qk } = await import('@/api/client');
const { queryClient } = await import('@/api/queryClient');
const { dismissToast, finishToast, shownToasts } = await import(
  '@/components/ui/userToast'
);
const { FileBody, MaterialContent } = await import('./CenterContent');

beforeEach(() => {
  queryClient.clear();
  dismissToast();
  for (const toast of Object.values(shownToasts()))
    if (toast) finishToast(toast.id);
});

/** The item pages: a quiz's, and a PDF's. */
const pages = {
  file: {
    body: (id: string) => (
      <FileBody
        fileId={id}
        imageZoom={1}
        onImageZoomChange={() => {}}
        trashed={false}
      />
    ),
    key: qk.file,
    row: { kind: 'pdf', name: 'Gone.pdf' },
  },
  material: {
    body: (id: string) => (
      <MaterialContent
        allowExternalAssets={false}
        centerQuiz={false}
        forceReadOnly={false}
        kind="quiz"
        materialId={id}
        onEditorStatusChange={() => {}}
      />
    ),
    key: qk.material,
    row: {
      capabilities: { canEdit: false, canEditContent: false },
      kind: 'quiz',
      title: 'Gone quiz',
    },
  },
};

/** Item `id`'s page, rendered with what `reads` says of it now. */
function itemPage(kind: keyof typeof pages, id: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container as never);
  const shown = (node: ReactNode) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
      )
    );
  return {
    render: () => shown(pages[kind].body(id)),
    unmount: () => act(async () => root.unmount()),
    /** Its read answering a fetch on the page, the item live: it worked. */
    worked: () =>
      act(async () => {
        await queryClient.fetchQuery({
          queryFn: async () => ({ id }),
          queryKey: pages[kind].key(id),
        });
      }),
  };
}

const lost = () => shownToasts().error;
const down = () => new ApiError(503, 'Service Unavailable');

// Review 2026-11-20 (3), round 3 (3): only forbidden or not found is lost
// access. A conflict, an undecodable item or a lapsed session read after the
// item worked here shows the page's own state, with no toast; a 404 then
// toasts.
for (const kind of ['material', 'file'] as const)
  it(`toasts on a ${kind}'s page for a read refusing access alone`, async () => {
    const id = `${kind}_refusals`;
    const page = itemPage(kind, id);
    reads[id] = { error: down() };
    await page.render();
    await page.worked();
    for (const [status, text] of [
      [409, 'Conflict'],
      [422, 'Unprocessable Entity'],
      [401, 'Unauthorized'],
    ] as const) {
      reads[id] = { error: new ApiError(status, text) };
      await page.render();
      expect(lost()).toBeNull();
      reads[id] = { error: down() };
      await page.render();
    }
    reads[id] = { error: new ApiError(404, 'Not Found') };
    await page.render();
    expect(lost()).toMatchObject({ count: 1, id: 'access-lost' });
    await page.unmount();
  });

// Review 2026-11-20, round 3 (2): another member trashed an item its payer has
// open after it worked there; their read answers the trashed row (deleted),
// and once it is purged the read's 404 is a deletion, not lost access.
for (const kind of ['material', 'file'] as const)
  it(`stays silent on a ${kind}'s page for a deleted item purged`, async () => {
    const id = `${kind}_purged`;
    const page = itemPage(kind, id);
    reads[id] = { error: down() };
    await page.render();
    await page.worked();
    const trashed = {
      ...pages[kind].row,
      id,
      trash: { canRestore: true, episodeId: 'ep', purgeAfter: '' },
      workspaceId: 'ws',
    };
    reads[id] = { data: trashed, error: null };
    await page.render();
    reads[id] = { data: trashed, error: new ApiError(404, 'Not Found') };
    await page.render();
    expect(lost()).toBeNull();
    await page.unmount();
  });
