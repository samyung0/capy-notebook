import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { CreateWorkspaceInviteBody } from '@/api/gen/validators';
import {
  useCreateWorkspaceInvite,
  useRemoveWorkspaceMember,
  useTransferWorkspace,
  useUpdateWorkspaceMember,
  useWorkspaceMembers,
} from '@/api/hooks';
import type {
  AssignableRole,
  CreateWorkspaceInviteReq,
  WorkspaceMember,
} from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
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

const ROLE_OPTIONS: Array<{ value: AssignableRole; label: string }> = [
  { label: 'View', value: 'viewer' },
  { label: 'Comment', value: 'commenter' },
  { label: 'Edit', value: 'editor' },
];

export function WorkspaceMemberManager({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const [transferTarget, setTransferTarget] = useState<WorkspaceMember | null>(
    null
  );
  const [manageTarget, setManageTarget] = useState<WorkspaceMember | null>(
    null
  );
  const [managedRole, setManagedRole] = useState<AssignableRole>('viewer');
  const { data: membersData } = useWorkspaceMembers(workspaceId, true, {
    errorBoundary: false,
  });
  const { mutateAsync: createInvite } = useCreateWorkspaceInvite(workspaceId);
  const { isPending: updateMemberIsPending, mutate: updateMember } =
    useUpdateWorkspaceMember(workspaceId);
  const { mutate: removeMember } = useRemoveWorkspaceMember(workspaceId);
  const { isPending: transferIsPending, mutateAsync: transfer } =
    useTransferWorkspace(workspaceId);

  const {
    formState: { isValid, isSubmitting },
    handleSubmit: formSubmit,
    control,
    reset,
  } = useForm<CreateWorkspaceInviteReq>({
    defaultValues: { identifier: '', role: 'viewer' },
    mode: 'onChange',
    resolver: zodResolver(CreateWorkspaceInviteBody),
  });

  const inviteDisabled = !isValid || isSubmitting;

  async function invite(v: CreateWorkspaceInviteReq) {
    try {
      await createInvite({
        identifier: v.identifier.trim(),
        role: v.role,
      });
      reset({ identifier: '', role: v.role });
      userToast({
        description: "If an account matches, they'll receive an invitation.",
        title: 'Invitation submitted',
      });
    } catch {
      // The global mutation handler shows the normalized failure.
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
    } catch {
      // The global mutation handler shows the normalized failure.
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

      <form className="mt-3 flex gap-2" onSubmit={formSubmit(invite)}>
        <Controller
          control={control}
          name="identifier"
          render={({ field, fieldState }) => (
            <div className="min-w-0 flex-1">
              <Input
                {...field}
                aria-invalid={fieldState.invalid}
                disabled={isSubmitting}
                placeholder="Email or user ID"
              />
              {fieldState.invalid && <InputError errors={[fieldState.error]} />}
            </div>
          )}
        />
        <Controller
          control={control}
          name="role"
          render={({ field }) => (
            <RoleSelect
              disabled={isSubmitting}
              label="Invite role"
              onChange={field.onChange}
              value={field.value}
            />
          )}
        />
        <Button
          className="w-19 rounded-input"
          disabled={inviteDisabled}
          type="submit"
          variant="accent"
        >
          {isSubmitting && (
            <span>
              <Spinner />
            </span>
          )}
          {!isSubmitting && 'Invite'}
        </Button>
      </form>

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
                      setManagedRole(member.role as AssignableRole);
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
  value: AssignableRole;
  onChange: (role: AssignableRole) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => onChange(next as AssignableRole)}
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
