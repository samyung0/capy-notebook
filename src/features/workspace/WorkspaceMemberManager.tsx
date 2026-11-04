import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { CreateWorkspaceInviteBody } from '@/api/gen/validators';
import {
  useCancelWorkspaceInvite,
  useCreateWorkspaceInvite,
  useRemoveWorkspaceMember,
  useTransferWorkspace,
  useUpdateWorkspaceMember,
  useWorkspace,
  useWorkspaceInvites,
  useWorkspaceMembers,
} from '@/api/hooks';
import type {
  AssignableRole,
  CreateWorkspaceInviteReq,
  WorkspaceMember,
} from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { TwoWaySwitch } from '@/components/ui/TwoWaySwitch';
import { userToast } from '@/components/ui/userToast';
import { getLocale, m } from '@/i18n';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/cn';
import { describeError, errorCopy, unexpectedErrorId } from '@/lib/errors';

type FormError = { errorId: string | null; message: string };

function formError(error: unknown): FormError {
  return {
    errorId: unexpectedErrorId(error),
    message: errorCopy(error, m.error_generic_body()),
  };
}

function day(iso: string) {
  return new Date(iso).toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'short',
  });
}

/** A class calls its viewers members and its editors teaching assistants (Epo
 * 2026-11-04): the names only, the roles underneath stay viewer and editor. */
function roleOptions(isClass: boolean) {
  return [
    {
      label: isClass ? m.role_member() : m.members_role_view(),
      value: 'viewer',
    },
    {
      label: isClass ? m.role_teaching_assistant() : m.members_role_edit(),
      value: 'editor',
    },
  ] as const satisfies readonly { label: string; value: AssignableRole }[];
}

/** People with access, each with their role. The owner (`canManage`) also
 * invites, changes a role and removes; an editor member reads the list. Leaving
 * is in Workspace settings → Danger. */
export function WorkspaceMemberManager({
  canManage,
  workspaceId,
}: {
  canManage: boolean;
  workspaceId: string;
}) {
  const { data: workspace } = useWorkspace(workspaceId, {
    errorBoundary: false,
  });
  const isClass = workspace?.kind === 'class';
  const {
    data: membersData,
    error: membersError,
    refetch: refetchMembers,
  } = useWorkspaceMembers(workspaceId, true, {
    errorBoundary: false,
  });
  const {
    data: invitesData,
    error: invitesError,
    refetch: refetchInvites,
  } = useWorkspaceInvites(workspaceId, {
    enabled: canManage,
    errorBoundary: false,
  });
  const { mutateAsync: createInvite } = useCreateWorkspaceInvite(workspaceId);
  const { mutateAsync: cancelInvite } = useCancelWorkspaceInvite(workspaceId);
  const [inviteError, setInviteError] = useState<FormError | null>(null);
  const [cancelError, setCancelError] = useState<FormError | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const {
    isPending: updatingRole,
    mutate: updateMember,
    variables: updated,
  } = useUpdateWorkspaceMember(workspaceId);
  const [removing, setRemoving] = useState<WorkspaceMember | null>(null);
  const roles = roleOptions(isClass);

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
    setInviteError(null);
    try {
      await createInvite({
        identifier: v.identifier.trim(),
        role: v.role,
      });
      track('collaborator_invited', { role: v.role });
      reset({ identifier: '', role: v.role });
      userToast({
        description: m.members_invite_sent_body(),
        title: m.members_invite_sent_title(),
      });
    } catch (error) {
      setInviteError(formError(error));
    }
  }

  async function cancel(inviteId: string) {
    setCancelError(null);
    setCancelling(inviteId);
    try {
      await cancelInvite(inviteId);
    } catch (error) {
      setCancelError(formError(error));
    } finally {
      setCancelling(null);
    }
  }

  return (
    <section aria-labelledby="workspace-members-title">
      <div>
        <InputTitle id="workspace-members-title">
          {m.members_people()}
        </InputTitle>
        {canManage && (
          <p className="t-meta text-fg-muted">{m.members_invite_hint()}</p>
        )}
      </div>

      {canManage && (
        <>
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={formSubmit(invite)}
          >
            <Controller
              control={control}
              name="role"
              render={({ field }) => (
                <TwoWaySwitch
                  className="self-start"
                  disabled={isSubmitting}
                  label={m.members_invite_role()}
                  onChange={field.onChange}
                  options={roles}
                  value={field.value}
                />
              )}
            />
            <div className="flex gap-2">
              <Controller
                control={control}
                name="identifier"
                render={({ field, fieldState }) => (
                  <div className="min-w-0 flex-1">
                    <Input
                      {...field}
                      aria-invalid={fieldState.invalid}
                      disabled={isSubmitting}
                      placeholder={m.members_invite_placeholder()}
                    />
                    {fieldState.invalid && (
                      <InputError errors={[fieldState.error]} />
                    )}
                  </div>
                )}
              />
              {/* Phones show the send icon alone. As tall as the field. */}
              <Button
                className="aspect-square px-0 sm:aspect-auto sm:px-5"
                disabled={inviteDisabled}
                type="submit"
                variant="ghost-hover"
              >
                <span className="sr-only sm:not-sr-only">
                  {m.members_invite()}
                </span>
                {isSubmitting ? <Spinner /> : <Icon name="send" />}
              </Button>
            </div>
          </form>
          <FormAlert
            errorId={inviteError?.errorId}
            message={inviteError?.message ?? null}
          />
        </>
      )}

      {!membersData && membersError && (
        <InlineErrorState
          className="py-6"
          errorId={unexpectedErrorId(membersError)}
          message={describeError(membersError).title}
          onRetry={() => void refetchMembers()}
        />
      )}
      <div className="mt-4 flex flex-col gap-1.5">
        {membersData?.map((member) => (
          <div className="flex items-center gap-2 py-1" key={member.userId}>
            <Avatar
              className="size-7.5 text-xs"
              name={member.name}
              src={member.avatarUrl}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-fg text-sm">
                {member.name}
              </p>
            </div>
            {member.role === 'owner' ? (
              <span className="px-2 font-medium text-fg-muted text-xs">
                {m.common_owner()}
              </span>
            ) : canManage ? (
              <>
                <RoleSelect
                  // Phones ellipsize Teaching assistant to leave room for the name.
                  className={cn(isClass ? 'w-32 sm:w-44' : 'w-22 sm:w-28')}
                  disabled={updatingRole}
                  label={m.members_role_of({ name: member.name })}
                  onChange={(role) =>
                    updateMember({ role, userId: member.userId })
                  }
                  options={roles}
                  value={
                    updatingRole && updated?.userId === member.userId
                      ? updated.role
                      : (member.role as AssignableRole)
                  }
                />
                <Button
                  aria-label={m.members_remove_named({ name: member.name })}
                  className="aspect-square px-0"
                  onClick={() => setRemoving(member)}
                  variant="danger-light"
                >
                  <Icon name="trash" />
                </Button>
              </>
            ) : (
              <span className="px-2 font-medium text-fg-muted text-xs">
                {roles.find((role) => role.value === member.role)?.label}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Every typed address, as typed and always as sent: whether one has
          an account never shows here. */}
      {canManage &&
        (!!invitesData?.length || (!invitesData && invitesError)) && (
          <div className="mt-4 flex flex-col gap-1.5">
            <p className="t-label text-fg-muted">{m.members_pending_title()}</p>
            {/* A failed load is not "nothing pending". */}
            {!invitesData && invitesError && (
              <InlineErrorState
                className="py-6"
                errorId={unexpectedErrorId(invitesError)}
                message={describeError(invitesError).title}
                onRetry={() => void refetchInvites()}
              />
            )}
            {invitesData?.map((pending) => (
              <div className="flex items-center gap-2 py-1" key={pending.id}>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-fg text-sm">
                    {pending.address}
                  </p>
                  <p className="t-meta text-fg-muted">
                    {m.members_pending_meta({
                      expires: day(pending.expiresAt),
                      sent: day(pending.sentAt),
                    })}
                  </p>
                </div>
                <Button
                  aria-label={m.members_pending_cancel_label({
                    address: pending.address,
                  })}
                  disabled={cancelling !== null}
                  onClick={() => void cancel(pending.id)}
                  size="sm"
                  variant="outline"
                >
                  {cancelling === pending.id ? <Spinner /> : m.action_cancel()}
                </Button>
              </div>
            ))}
            <FormAlert
              errorId={cancelError?.errorId}
              message={cancelError?.message ?? null}
            />
          </div>
        )}

      {removing && (
        <RemoveMemberDialog
          member={removing}
          onClose={() => setRemoving(null)}
          workspaceId={workspaceId}
        />
      )}
    </section>
  );
}

function RemoveMemberDialog({
  workspaceId,
  member,
  onClose,
}: {
  workspaceId: string;
  member: WorkspaceMember;
  onClose: () => void;
}) {
  const { isPending, mutateAsync: remove } =
    useRemoveWorkspaceMember(workspaceId);
  return (
    <ConfirmDialog
      body={m.members_remove_confirm_body({ name: member.name })}
      closeOnConfirm={false}
      confirmLabel={m.action_remove()}
      danger
      isSubmitting={isPending}
      onClose={() => {
        if (!isPending) onClose();
      }}
      onConfirm={async () => {
        try {
          await remove(member.userId);
          onClose();
        } catch {
          // The mutation handler reports the failure; keep the confirmation open.
        }
      }}
      open
      title={m.members_remove_confirm_title({ name: member.name })}
    />
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
  options,
  label,
  className,
}: {
  className: string;
  value: AssignableRole;
  onChange: (role: AssignableRole) => void;
  disabled?: boolean;
  options: ReturnType<typeof roleOptions>;
  label: string;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => onChange(next as AssignableRole)}
      value={value}
    >
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function WorkspaceTransferDialog({
  workspaceId,
  member,
  onClose,
}: {
  workspaceId: string;
  member: WorkspaceMember;
  onClose: () => void;
}) {
  const { isPending, mutateAsync: transfer } =
    useTransferWorkspace(workspaceId);
  const { data: workspace } = useWorkspace(workspaceId, {
    errorBoundary: false,
  });
  return (
    <ConfirmDialog
      body={
        workspace?.kind === 'class'
          ? m.workspace_transfer_confirm_body_class({ name: member.name })
          : m.workspace_transfer_confirm_body({ name: member.name })
      }
      closeOnConfirm={false}
      confirmLabel={m.workspace_transfer_confirm()}
      danger
      isSubmitting={isPending}
      onClose={() => {
        if (!isPending) onClose();
      }}
      onConfirm={async () => {
        try {
          await transfer(member.userId);
          onClose();
          userToast({
            title: m.workspace_transfer_success(),
            variant: 'success',
          });
        } catch {
          // The mutation handler reports the failure; keep the confirmation open.
        }
      }}
      open
      title={m.workspace_transfer_title()}
    />
  );
}
