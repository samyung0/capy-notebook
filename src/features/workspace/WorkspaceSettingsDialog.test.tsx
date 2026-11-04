import { parseHTML } from 'linkedom';
import type { ComponentProps, ReactNode } from 'react';
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

const idle = { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() };
vi.mock('@/api/hooks', () => ({
  useDeleteWorkspace: () => idle,
  useLeaveWorkspace: () => idle,
  useMe: () => ({ data: { id: 'u_me' } }),
  useSetWorkspaceStudyEnabled: () => idle,
  useUpdateWorkspace: () => idle,
  useUpdateWorkspaceSharing: () => idle,
  useWorkspaceStats: () => ({}),
  useWorkspaceStudy: () => ({}),
}));
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({}),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/ui/Tabs', () => ({
  Tabs: ({ tabs }: { tabs: { label: ReactNode; value: string }[] }) =>
    tabs.map((tab) => (
      <button key={tab.value} type="button">
        {tab.label}
      </button>
    )),
}));
let phone = false;
vi.mock('@/components/ui/Dialog', () => ({
  ConfirmDialog: () => null,
  SimpleDialog: ({ children }: { children: ReactNode }) => children,
  useIsPhone: () => phone,
}));
vi.mock('@/components/ui/SearchInput', () => ({ SearchInput: () => null }));
vi.mock('./CloneWorkspaceDialog', () => ({ CloneWorkspaceDialog: () => null }));
vi.mock('./ShareDialog', () => ({ ShareDialog: () => null }));
vi.mock('./WorkspaceFormEditDialog', () => ({
  WorkspaceFormEditDialog: () => null,
}));
vi.mock('./WorkspaceMemberManager', () => ({
  WorkspaceTransferDialog: () => null,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WorkspaceSettingsDialog } = await import('./WorkspaceSettingsDialog');

async function buttons(
  props: Partial<ComponentProps<typeof WorkspaceSettingsDialog>>
) {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <WorkspaceSettingsDialog
        onClose={() => {}}
        open
        workspace={ownedWorkspace}
        {...props}
      />
    )
  );
  const labels = [...document.querySelectorAll('button')].map((button) =>
    button.textContent?.trim()
  );
  act(() => root.unmount());
  return labels;
}

const workspaceAs = (role: 'owner' | 'editor' | 'viewer') =>
  ({
    canClone: false,
    capabilities: {
      canEdit: role === 'owner',
      canEditContent: role === 'owner',
      canManageMembers: role === 'owner',
      canView: true,
    },
    id: 'ws_1',
    name: 'Biology',
    role,
  }) as Workspace;
const ownedWorkspace = workspaceAs('owner');

afterEach(() => {
  phone = false;
});

// The Danger tab holds Transfer and Delete for the owner and Leave for any
// other member (Epo 2026-10-28, 2026-11-04), each only its own actions.
it.each([
  ['the owner', 'owner', [m.workspace_transfer_confirm(), m.action_delete()]],
  ['an editor', 'editor', [m.action_leave()]],
  ['a viewer', 'viewer', [m.action_leave()]],
] as const)(
  'shows %s only its own Danger actions',
  async (_, role, actions) => {
    const labels = await buttons({
      initialTab: 'danger',
      workspace: workspaceAs(role),
    });
    expect(labels).toEqual(expect.arrayContaining([...actions]));
    expect(labels).not.toContain(
      role === 'owner' ? m.action_leave() : m.action_delete()
    );
  }
);

it('narrows the tabs to the one holding a match and names the setting', async () => {
  expect(await buttons({ query: 'transfer', tab: 'study' })).toEqual([
    `${m.workspace_tab_danger()}${m.workspace_transfer_action()}`,
  ]);
});

it('shows a phone the tab list until a tab is picked', async () => {
  phone = true;
  expect(await buttons({ tab: 'menu' })).not.toContain(m.action_delete());
  expect(await buttons({ tab: 'danger' })).toContain(m.action_delete());
});
