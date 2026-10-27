import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Workspace } from '@/api/types';
import { getLocale, m } from '@/i18n';

// The locale resolves before a window exists (see EmbedsTab.test.tsx), then
// linkedom's document goes in before react-dom/client loads.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const state = vi.hoisted(() => ({
  storage: null as null | { kind: string; short: string },
  workspaces: [] as Partial<Workspace>[],
}));
vi.mock('@/api/hooks', () => ({
  useDeleteOwnedFile: () => ({ mutateAsync: vi.fn() }),
  useOwnedFiles: () => ({
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
vi.mock('@/features/materials/MaterialsTab', () => ({
  locationLabel: (value: string) => value,
  MaterialsTab: () => null,
}));
vi.mock('@/features/files/EmbedsTab', () => ({ EmbedsTab: () => null }));
vi.mock('@/features/workspace/WorkspaceHealth', () => ({
  AccountStatusButton: () => null,
  useAccountFrozen: () => false,
  useStorageStatus: () => state.storage,
}));
vi.mock('@/features/workspace/AddSourceDialog', () => ({
  AddSourceDialog: ({ workspaceId }: { workspaceId: string | null }) => (
    <div data-add-source={String(workspaceId)} />
  ),
  resumedConnect: () => null,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Files } = await import('./Files');

const workspace = (id: string, name: string, canEdit: boolean) =>
  ({
    capabilities: { canEdit },
    iconId: 'books',
    id,
    name,
  }) as Partial<Workspace>;

afterEach(() => {
  state.storage = null;
});

const buttonByText = (text: string) =>
  [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text
  );

async function openChooser() {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(<Files />));
  await act(async () => {
    buttonByText(m.action_add_file())?.dispatchEvent(
      new window.Event('click', { bubbles: true })
    );
  });
  const rows = [
    ...document.querySelectorAll('[role=dialog] button'),
  ] as HTMLButtonElement[];
  return { root, rows };
}

// Add file (P3, 2026-10-27): No workspace first, then the workspaces the
// caller edits in the list's order; the pick opens the Add file dialog for
// that destination.
it('offers No workspace and editable workspaces, then opens Add file there', async () => {
  state.workspaces = [
    workspace('ws_bio', 'Biology', true),
    workspace('ws_view', 'Shared reading', false),
    workspace('ws_chem', 'Chemistry', true),
  ];
  const { root, rows } = await openChooser();
  expect(rows.map((row) => row.textContent?.trim())).toEqual([
    m.clone_no_workspace(),
    'Biology',
    'Chemistry',
  ]);

  await act(async () => {
    rows[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(
    document.querySelector('[data-add-source]')?.getAttribute('data-add-source')
  ).toBe('ws_bio');
  await act(async () => root.unmount());

  const second = await openChooser();
  await act(async () => {
    second.rows[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  expect(
    document.querySelector('[data-add-source]')?.getAttribute('data-add-source')
  ).toBe('null');
  await act(async () => second.root.unmount());
});

it('turns every destination off for a frozen account, with the reason', async () => {
  state.workspaces = [workspace('ws_bio', 'Biology', true)];
  state.storage = { kind: 'frozen-self', short: m.account_frozen_short() };
  const { root, rows } = await openChooser();
  expect(rows.every((row) => row.disabled)).toBe(true);
  expect(document.querySelector('[role=dialog]')?.textContent).toContain(
    m.account_frozen_short()
  );
  await act(async () => root.unmount());
});
