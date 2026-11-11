import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { Workspace } from '@/api/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const workspace = (id: string, kind: string, role: string) =>
  ({ iconId: 'i', id, kind, name: id, role, tags: [] }) as unknown as Workspace;
const list = vi.hoisted(() => ({ value: [] as Workspace[] }));
vi.mock('@/api/hooks', () => ({
  useWorkspaces: () => ({ data: list.value }),
}));
vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
vi.mock('./LazyNewAssignmentDialog', () => ({
  NewAssignmentDialog: ({
    workspaceId,
    workspaces,
  }: {
    workspaceId: string;
    workspaces: Workspace[];
  }) => (
    <div
      data-form={workspaceId}
      data-offered={workspaces.map((ws) => ws.id).join(',')}
    />
  ),
}));

const { createRoot } = await import('react-dom/client');
const { NewAssignmentAnywhere } = await import('./NewAssignmentAnywhere');

const host = document.createElement('div');
document.body.append(host);
const show = async (workspaces: Workspace[]) => {
  list.value = workspaces;
  const root = createRoot(host);
  await act(async () => root.render(<NewAssignmentAnywhere />));
  return root;
};
const opener = () =>
  [...host.querySelectorAll('button')].find(
    (button) => button.textContent === m.todo_add_task()
  );

it('opens the one form at once with no workspace, offering those the caller is a member of', async () => {
  const root = await show([
    workspace('mine', 'class', 'owner'),
    workspace('joined', 'class', 'viewer'),
    workspace('visited', 'personal', ''),
  ]);
  await act(async () => opener()?.click());
  const form = host.querySelector('[data-form]');
  expect(form?.getAttribute('data-form')).toBe('');
  expect(form?.getAttribute('data-offered')).toBe('mine,joined');
  await act(async () => root.unmount());
});

it('offers Add task to someone with no workspace', async () => {
  const none = await show([]);
  expect(opener()).toBeDefined();
  await act(async () => none.unmount());
});
