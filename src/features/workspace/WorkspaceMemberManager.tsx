import { useState } from 'react';
import {
  useCreateWorkspaceInvite,
  useRemoveWorkspaceMember,
  useTransferWorkspace,
  useUpdateWorkspaceMember,
  useWorkspaceMembers,
} from '@/api/hooks';
import type { WorkspaceMember, WorkspaceRole } from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputTitle } from '@/components/ui/Input';
import { Menu } from '@/components/ui/Menu';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

type MemberRole = Exclude<WorkspaceRole, 'owner'>;

const ROLE_OPTIONS: Array<{ value: MemberRole; label: string }> = [
  { label: 'View', value: 'viewer' },
  { label: 'Comment', value: 'commenter' },
  { label: 'Edit', value: 'editor' },
];

export function WorkspaceMemberManager({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const [identifier, setIdentifier] = useState('');
  const [role, setRole] = useState<MemberRole>('viewer');
  const [transferTarget, setTransferTarget] = useState<WorkspaceMember | null>(
    null
  );
  const [manageTarget, setManageTarget] = useState<WorkspaceMember | null>(
    null
  );
  const [managedRole, setManagedRole] = useState<MemberRole>('viewer');
  const { data: membersData } = useWorkspaceMembers(workspaceId);
  const { isPending: createInviteIsPending, mutateAsync: createInvite } =
    useCreateWorkspaceInvite(workspaceId);
  const { isPending: updateMemberIsPending, mutate: updateMember } =
    useUpdateWorkspaceMember(workspaceId);
  const { mutate: removeMember } = useRemoveWorkspaceMember(workspaceId);
  const { isPending: transferIsPending, mutateAsync: transfer } =
    useTransferWorkspace(workspaceId);

  async function invite() {
    const value = identifier.trim();
    if (!value) return;
    try {
      await createInvite({ identifier: value, role });
      setIdentifier('');
      userToast({
        description: "If an account matches, they'll receive an invitation.",
        title: 'Invitation submitted',
      });
    } catch {
      userToast({
        description: 'Something went wrong. Please try again.',
        title: 'Could not send invitation',
        variant: 'error',
      });
    }
  }

  async function confirmTransfer() {
    if (!transferTarget) return;
    try {
      await transfer(transferTarget.userId);
      setTransferTarget(null);
      userToast({
        title: m.workspace_transfer_success(),
        variant: 'success',
      });
    } catch (err) {
      userToast({
        description:
          err instanceof Error
            ? err.message
            : 'Something went wrong. Please try again.',
        title: m.workspace_transfer_failed(),
        variant: 'error',
      });
    }
  }

  return (
    <section aria-labelledby="workspace-members-title">
      <div>
        <InputTitle id="workspace-members-title">People with access</InputTitle>
        <p className="t-meta text-fg-muted">
          Invite by exact email or user ID. They must accept before access is
          granted.
        </p>
      </div>

      <div className="mt-3 flex gap-2">
        <Input
          disabled={createInviteIsPending}
          onChange={(event) => setIdentifier(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void invite();
          }}
          placeholder="Email or user ID"
          value={identifier}
          wrapperClassName="min-w-0 flex-1"
        />
        <RoleSelect
          disabled={createInviteIsPending}
          label="Invite role"
          onChange={setRole}
          value={role}
        />
        <Button
          className="w-19 rounded-input"
          disabled={createInviteIsPending || !identifier.trim()}
          onClick={() => void invite()}
          variant="accent"
        >
          {createInviteIsPending && (
            <span>
              <Spinner />
            </span>
          )}
          {!createInviteIsPending && 'Invite'}
        </Button>
      </div>

      <div className="mt-4 flex flex-col gap-1.5">
        {membersData?.map((member) => (
          <div className="flex items-center gap-2 py-1" key={member.userId}>
            <Avatar name={member.name} size="sm" src={member.avatarUrl} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-fg text-sm">
                {member.name}
              </p>
              <p className="truncate text-fg-muted text-xs">{member.email}</p>
            </div>
            {member.role === 'owner' ? (
              <span className="px-2 font-medium text-fg-muted text-xs">
                Owner
              </span>
            ) : (
              <Menu
                items={[
                  {
                    label: 'Manage Member',
                    onClick: () => {
                      setManageTarget(member);
                      setManagedRole(member.role as MemberRole);
                    },
                  },
                  {
                    danger: true,
                    label: 'Remove',
                    onClick: () => removeMember(member.userId),
                  },
                ]}
              />
            )}
          </div>
        ))}
      </div>

      <SimpleDialog
        onClose={() => setManageTarget(null)}
        open={!!manageTarget}
        title="Manage Member"
      >
        {manageTarget && (
          <div className="flex flex-col gap-1.5">
            <InputTitle>Role</InputTitle>
            <RoleSelect
              disabled={updateMemberIsPending}
              label="Role"
              onChange={(nextRole) => {
                setManagedRole(nextRole);
                updateMember({
                  role: nextRole,
                  userId: manageTarget.userId,
                });
              }}
              value={managedRole}
            />
          </div>
        )}
      </SimpleDialog>

      <ConfirmDialog
        body={
          transferTarget
            ? m.workspace_transfer_confirm_body({
                name: transferTarget.name,
              })
            : undefined
        }
        closeOnConfirm={false}
        confirmLabel={m.workspace_transfer_confirm()}
        danger
        isSubmitting={transferIsPending}
        onClose={() => {
          if (!transferIsPending) setTransferTarget(null);
        }}
        onConfirm={() => void confirmTransfer()}
        open={!!transferTarget}
        title={m.workspace_transfer_title()}
      />
    </section>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
  label,
}: {
  value: MemberRole;
  onChange: (role: MemberRole) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => onChange(next as MemberRole)}
      value={value}
    >
      <SelectTrigger aria-label={label} className="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {ROLE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
