import { renderToStaticMarkup } from 'react-dom/server';
import { useForm } from 'react-hook-form';
import { expect, it, vi } from 'vitest';
import type { Workspace } from '@/api/types';
import { m } from '@/i18n';
import { MembersRoster } from './MembersRoster';

vi.mock('@/api/hooks', () => ({
  useMe: () => ({ data: { id: 'u_kate' } }),
  useUpdateWorkspaceSharing: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('@/features/workspace/ShareDialog', () => ({
  ShareDialog: ({ members }: { members: boolean }) => (
    <div data-link-sharing={String(members)} />
  ),
}));
vi.mock('@/features/workspace/WorkspaceMemberManager', () => ({
  inviteDay: (iso: string) => iso,
  RemoveMemberDialog: () => null,
  RoleSelect: ({ label, value }: { label: string; value: string }) => (
    <select aria-label={label} defaultValue={value} />
  ),
  useMemberManager: (_id: string, canManage: boolean) => {
    const { control } = useForm({
      defaultValues: { identifier: '', role: 'viewer' },
    });
    return {
      control,
      invitesData: canManage
        ? [{ address: 'jo@example.com', expiresAt: 'a', id: 'i1', sentAt: 'b' }]
        : undefined,
      isClass: false,
      membersData: [
        { name: 'Kate Malone', role: 'owner', userId: 'u_kate' },
        { name: 'Noor Haddad', role: 'editor', userId: 'u_noor' },
      ],
      roles: [
        { label: m.members_role_view(), value: 'viewer' },
        { label: m.members_role_edit(), value: 'editor' },
      ],
    };
  },
}));

const render = (role: 'owner' | 'editor' | 'viewer') =>
  renderToStaticMarkup(
    <MembersRoster
      workspace={
        {
          capabilities: { canManageMembers: role === 'owner' },
          id: 'ws',
          kind: 'personal',
          name: 'Calculus II',
          privacy: 'private',
          role,
          sharePath: '/w/ws',
        } as Workspace
      }
    />
  );

// Epo 2026-11-11, mock C: no marks on this page.
it('lets the owner invite, change a role and remove, and set link sharing', () => {
  const html = render('owner');
  expect(html).toContain(m.workspace_members_count({ count: 2 }));
  expect(html).toContain(m.members_invite_placeholder());
  // A role dropdown for the invitation and one for the editor's row; the
  // owner's own row has neither a dropdown nor Remove.
  expect(html.match(/<select/g)).toHaveLength(2);
  expect(html).toContain(m.members_remove_named({ name: 'Noor Haddad' }));
  expect(html).not.toContain(m.members_remove_named({ name: 'Kate Malone' }));
  expect(html).toContain('jo@example.com');
  // Link sharing without a second list of the people, above them as in the
  // settings page.
  expect(html).toContain('data-link-sharing="false"');
  expect(html.indexOf('data-link-sharing')).toBeLessThan(
    html.indexOf(m.members_invite_placeholder())
  );
});

it('shows everyone else the people and their roles', () => {
  const viewer = render('viewer');
  expect(viewer).toContain('Noor Haddad');
  expect(viewer).toContain(m.common_owner());
  expect(viewer).toContain(m.members_role_edit());
  expect(viewer).not.toContain(m.members_invite_placeholder());
  expect(viewer).not.toContain(m.members_remove_named({ name: 'Noor Haddad' }));
  expect(viewer).not.toContain('data-link-sharing');
  // An editor shares the workspace, so sets its link sharing too.
  expect(render('editor')).toContain('data-link-sharing="false"');
});
