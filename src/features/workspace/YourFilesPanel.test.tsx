import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import type { SourceFile } from '@/api/types';
import { getLocale, m } from '@/i18n';

// The locale resolves before a window exists (see EmbedsTab.test.tsx), then
// linkedom's document goes in before react-dom/client loads.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const file = (id: string, workspaceId: string, extra?: Partial<SourceFile>) =>
  ({
    id,
    kind: 'pdf',
    name: `${id}.pdf`,
    workspaceId,
    ...extra,
  }) as SourceFile;
vi.mock('@/api/hooks', async (original) => ({
  ...(await original<typeof import('@/api/hooks')>()),
  useChapters: () => ({ data: [] }),
  useOwnedFiles: () => ({
    data: {
      pages: [
        {
          items: [
            file('lost', 'ws_gone', { lostAccess: true }),
            file('here', 'ws_a'),
            file('other', 'ws_b', { workspaceName: 'Physics' }),
            file('alone', ''),
          ],
        },
      ],
    },
    hasNextPage: false,
    isPending: false,
  }),
  useWorkspace: () => ({ data: { id: 'ws_a', name: 'Biology' } }),
  useWorkspaces: () => ({ data: [] }),
}));
vi.mock('@/components/ui/Dialog', () => ({
  ConfirmDialog: () => null,
  DialogFooter: ({ children }: { children: ReactNode }) => children,
  DialogPrimary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/app/ListEnd', () => ({ ListEnd: () => null }));
vi.mock('@/components/app/ThumbnailPanel', () => ({
  ThumbnailPanel: () => null,
}));
vi.mock('./ChapterSelect', async (original) => ({
  ...(await original<typeof import('./ChapterSelect')>()),
  ChapterSelect: () => null,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { YourFilesPanel } = await import('./YourFilesPanel');

const card = (name: string) =>
  [...document.querySelectorAll('button[aria-pressed]')].find((button) =>
    button.textContent?.includes(name)
  ) as HTMLButtonElement | undefined;
const click = (element?: Element) =>
  act(async () => {
    element?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });

it('lists the files the user pays for and moves the picked ones here', async () => {
  const posted: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return Response.json([]);
    })
  );
  const onMoved = vi.fn();
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <YourFilesPanel onMoved={onMoved} workspaceId="ws_a" />
      </QueryClientProvider>
    )
  );

  expect(card('lost.pdf')).toBeUndefined();
  const here = card('here.pdf');
  expect(here?.disabled).toBe(true);
  expect(here?.textContent).toContain(m.source_your_files_here());
  expect(card('other.pdf')?.textContent).toContain('Physics');
  expect(card('alone.pdf')?.textContent).toBe('alone.pdf');

  await click(card('other.pdf'));
  await click(card('alone.pdf'));
  const move = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === m.source_move_files({ count: 2 })
  );
  await click(move);
  expect(posted).toEqual([
    { fileIds: ['other', 'alone'], workspaceId: 'ws_a' },
  ]);
  expect(onMoved).toHaveBeenCalled();
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
