import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import type { Workspace } from '@/api/types';
import { getLocale, m } from '@/i18n';

// The locale resolves before a window exists (see ItemsList.test.tsx), then
// linkedom's document goes in before react-dom/client loads.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const state = vi.hoisted(() => ({ workspaces: [] as Partial<Workspace>[] }));
vi.mock('@/api/hooks', () => ({
  useDeleteEditorAsset: () => ({ mutateAsync: vi.fn() }),
  useDeleteOwnedFile: () => ({ mutateAsync: vi.fn() }),
  useDeleteOwnedMaterial: () => ({ mutateAsync: vi.fn() }),
  useDeletePaper: () => ({ mutateAsync: vi.fn() }),
  useItems: () => ({
    data: { pages: [{ items: [] }] },
    fetchStatus: 'idle',
    hasNextPage: false,
    isLoading: false,
  }),
  usePurgeTrashed: () => ({ mutateAsync: vi.fn() }),
  useRestoreTrashed: () => ({ mutateAsync: vi.fn() }),
  useRetryFileProcessing: () => ({ mutateAsync: vi.fn() }),
  useRetryingFileIds: () => [],
  useTrash: () => ({}),
  useWorkspaces: () => ({ data: state.workspaces, isLoading: false }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  linkOptions: <T,>(options: T) => options,
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));
vi.mock('usehooks-ts', () => ({ useMediaQuery: () => true }));
vi.mock('radix-ui', async (original) => {
  const radix = await original<typeof import('radix-ui')>();
  return {
    ...radix,
    Dialog: {
      ...radix.Dialog,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    },
  };
});
vi.mock('@/components/ui/Dialog', () => ({
  ConfirmDialog: () => null,
  SimpleDialog: ({
    children,
    open,
    title,
  }: {
    children: ReactNode;
    open: boolean;
    title: ReactNode;
  }) =>
    open ? (
      <div role="dialog">
        {title}
        {children}
      </div>
    ) : null,
}));
vi.mock('@/components/app/layout', () => ({
  PageBody: ({ children }: { children: ReactNode }) => children,
  PageHeader: ({ actions }: { actions: ReactNode }) => actions,
  PagePanel: ({
    children,
    header,
  }: {
    children: ReactNode;
    header: ReactNode;
  }) => (
    <>
      {header}
      {children}
    </>
  ),
}));
vi.mock('@/components/app/ListToolbar', async (original) => ({
  ...(await original<typeof import('@/components/app/ListToolbar')>()),
  ListToolbar: ({ action }: { action: ReactNode }) => action,
}));
vi.mock('@/components/ui/Tabs', () => ({ Tabs: () => null }));
vi.mock('@/features/materials/useBlockActions', () => ({
  blockLink: () => ({}),
  useBlockActions: () => ({
    dialogs: null,
    frozen: false,
    menuFor: () => [],
  }),
}));
vi.mock('@/features/workspace/WorkspaceHealth', () => ({
  AccountStatusButton: () => null,
  useAccountFrozen: () => false,
}));
// Its Add to field, as a button that picks Biology.
vi.mock('@/features/workspace/LazyAddSourceDialog', () => ({
  AddSourceDialog: ({
    onDestinationChange,
    workspaceId,
  }: {
    onDestinationChange?: (id: string | null) => void;
    workspaceId: string | null;
  }) => (
    <button
      data-add-source={String(workspaceId)}
      onClick={() => onDestinationChange?.('ws_bio')}
      type="button"
    />
  ),
  addSourceIntent: {},
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Files } = await import('./Files');

const buttonByText = (text: string) =>
  [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text
  );
const addSource = () => document.querySelector('[data-add-source]');

// Add file (Epo 2026-11-12): its dialog opens at once on No workspace, and the
// destination is picked in it.
it('opens Add file on No workspace and follows the destination picked in it', async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(<Files />));
  await act(async () => {
    buttonByText(m.action_add_file())?.dispatchEvent(
      new window.Event('click', { bubbles: true })
    );
  });
  expect(addSource()?.getAttribute('data-add-source')).toBe('null');
  await act(async () => {
    addSource()?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  expect(addSource()?.getAttribute('data-add-source')).toBe('ws_bio');
  await act(async () => root.unmount());
});
