import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { EditorAssetAccess, EditorAssetPage } from './types';

// linkedom's document before react-dom/client loads, which reads it once.
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });
vi.mock('./auth', () => ({ authHeaders: async () => ({}), USE_MSW: false }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('./client');
const { useEditorAssets } = await import('./hooks');
afterEach(() => vi.restoreAllMocks());

// Switching the Embeds tab's access filter loads the new list afresh rather
// than keeping the previous filter's rows on screen, so the lost notice
// never sits over rows it does not describe (M16).
it("drops the previous filter's rows while the next filter loads", async () => {
  const page = (assetId: string): EditorAssetPage => ({
    items: [
      {
        assetId,
        createdAt: '',
        lostAccess: false,
        materialTitle: '',
        name: '',
        purpose: 'image',
        sizeBytes: 1,
        workspaceName: '',
      },
    ],
  });
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    path.includes('access=lost')
      ? new Promise(() => undefined)
      : Promise.resolve(page('asset_open'))
  );
  function Probe({ access }: { access?: EditorAssetAccess }) {
    const { data } = useEditorAssets(access);
    const ids = data?.pages.flatMap((p) => p.items.map((i) => i.assetId));
    return <p>{ids ? ids.join(',') : 'loading'}</p>;
  }
  const client = new QueryClient();
  const root = createRoot(document.getElementById('root') as never);
  const show = (access?: EditorAssetAccess) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe access={access} />
        </QueryClientProvider>
      )
    );
  const text = () => document.getElementById('root')?.textContent;
  await show('open');
  await act(() => vi.waitFor(() => expect(text()).toBe('asset_open')));
  await show('lost');
  expect(text()).toBe('loading');
  await act(async () => root.unmount());
  client.clear();
});
