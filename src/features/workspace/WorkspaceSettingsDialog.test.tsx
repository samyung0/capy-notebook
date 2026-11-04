import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
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
vi.mock('@/components/ui/Tabs', () => ({ Tabs: () => null }));
vi.mock('@/components/ui/Dialog', () => ({
  ConfirmDialog: () => null,
  SimpleDialog: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./CloneWorkspaceDialog', () => ({ CloneWorkspaceDialog: () => null }));
vi.mock('./ShareDialog', () => ({ ShareDialog: () => null }));
vi.mock('./WorkspaceFormEditDialog', () => ({
  WorkspaceFormEditDialog: () => null,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WorkspaceSettingsDialog } = await import('./WorkspaceSettingsDialog');

async function dangerButtons(workspace: Partial<Workspace>) {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <WorkspaceSettingsDialog
        initialTab="danger"
        onClose={() => {}}
        open
        workspace={workspace as Workspace}
      />
    )
  );
  const labels = [...document.querySelectorAll('button')].map((button) =>
    button.textContent?.trim()
  );
  act(() => root.unmount());
  return labels;
}

// The Danger tab holds Delete for the owner and Leave for any other member
// (Epo 2026-10-28), each only its own action.
it.each([
  ['the owner', 'owner', true, m.action_delete()],
  ['an editor', 'editor', false, m.action_leave()],
  ['a viewer', 'viewer', false, m.action_leave()],
] as const)(
  'shows %s only its own Danger action',
  async (_, role, owner, action) => {
    const labels = await dangerButtons({
      canClone: false,
      capabilities: {
        canEdit: owner,
        canEditContent: owner,
        canManageMembers: owner,
        canView: true,
      },
      id: 'ws_1',
      name: 'Biology',
      role,
    });
    expect(labels).toContain(action);
    expect(labels).not.toContain(owner ? m.action_leave() : m.action_delete());
  }
);
