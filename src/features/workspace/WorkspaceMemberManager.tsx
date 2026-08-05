import { useState } from 'react';
import {
  useCreateWorkspaceInvite,
  useMe,
  useRemoveWorkspaceMember,
  useTransferWorkspace,
  useUpdateWorkspaceMember,
  useWorkspaceMembers,
} from '@/api/hooks';
import type { WorkspaceMember, WorkspaceRole } from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Input, InputTitle } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
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
  const me = useMe();
  const members = useWorkspaceMembers(workspaceId);
  const createInvite = useCreateWorkspaceInvite(workspaceId);
  const updateMember = useUpdateWorkspaceMember(workspaceId);
  const removeMember = useRemoveWorkspaceMember(workspaceId);
  const transfer = useTransferWorkspace(workspaceId);

  const isOwner = members.data?.some(
    (member) => member.userId === me.data?.id && member.role === 'owner'
  );

  async function invite() {
    const value = identifier.trim();
    if (!value) return;
    try {
      await createInvite.mutateAsync({ identifier: value, role });
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
      await transfer.mutateAsync(transferTarget.userId);
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
    <section
      aria-labelledby="workspace-members-title"
      className="border-divider border-t pt-4"
    >
      <div>
        <InputTitle id="workspace-members-title">People with access</InputTitle>
        <p className="t-meta text-fg-muted">
          Invite by exact email or user ID. They must accept before access is
          granted.
        </p>
      </div>

      <div className="mt-3 flex gap-2">
        <Input
          disabled={createInvite.isPending}
          onChange={(event) => setIdentifier(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void invite();
          }}
          placeholder="Email or user ID"
          value={identifier}
          wrapperClassName="min-w-0 flex-1"
        />
        <RoleSelect
          disabled={createInvite.isPending}
          onChange={setRole}
          value={role}
        />
        <Button
          disabled={createInvite.isPending || !identifier.trim()}
          onClick={() => void invite()}
          size="sm"
          variant="accent"
        >
          {createInvite.isPending ? 'Inviting…' : 'Invite'}
        </Button>
      </div>

      <div className="mt-4 flex flex-col gap-1.5">
        {members.data?.map((member) => (
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
              <>
                <RoleSelect
                  disabled={updateMember.isPending || removeMember.isPending}
                  onChange={(nextRole) =>
                    updateMember.mutate({
                      role: nextRole,
                      userId: member.userId,
                    })
                  }
                  value={member.role}
                />
                {isOwner && (
                  <Button
                    disabled={transfer.isPending}
                    onClick={() => setTransferTarget(member)}
                    size="sm"
                    variant="ghost"
                  >
                    {m.workspace_transfer_action()}
                  </Button>
                )}
                <Button
                  disabled={removeMember.isPending}
                  onClick={() => removeMember.mutate(member.userId)}
                  size="sm"
                  variant="ghost"
                >
                  Remove
                </Button>
              </>
            )}
          </div>
        ))}
      </div>

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
        isSubmitting={transfer.isPending}
        onClose={() => {
          if (!transfer.isPending) setTransferTarget(null);
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
}: {
  value: MemberRole;
  onChange: (role: MemberRole) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => onChange(next as MemberRole)}
      value={value}
    >
      <SelectTrigger className="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
