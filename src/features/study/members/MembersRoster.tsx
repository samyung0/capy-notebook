import type { ReactNode } from 'react';
import { Controller } from 'react-hook-form';
import { useMe, useUpdateWorkspaceSharing } from '@/api/hooks';
import type { AssignableRole, Workspace } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { FormAlert } from '@/components/ui/FormAlert';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError } from '@/components/ui/Input';
import { Separator } from '@/components/ui/Separator';
import { canManageWorkspaceSettings } from '@/features/workspace/access';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import {
  inviteDay,
  RemoveMemberDialog,
  RoleSelect,
  useMemberManager,
} from '@/features/workspace/WorkspaceMemberManager';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { describeError, unexpectedErrorId } from '@/lib/errors';
import { PracticeFrame } from '../practice/studyPage';

/** Members without marks (Epo 2026-11-11, mock C "Manage in place"): everyone in
 * a personal workspace, a class's viewers, who see no one's marks, and the
 * Manage tab of a class's owner and teaching assistants. The
 * people with their roles; the owner invites from the row at the top, changes a
 * role with the row's dropdown and removes with its button, after a
 * confirmation. Roles and buttons each keep one width, so every row ends on
 * the same line. Whoever shares the workspace (owner and editors) sets its
 * link sharing above the people, in the settings page's order. */
export function MembersRoster({
  header,
  workspace,
}: {
  /** A class's staff: the Members heading with its tabs, in place of this
   * page's own. */
  header?: ReactNode;
  workspace: Workspace;
}) {
  const canManage = workspace.capabilities.canManageMembers;
  const shares = canManageWorkspaceSettings(workspace);
  const { data: me } = useMe({ errorBoundary: false });
  const { isPending: sharing, mutateAsync: updateSharing } =
    useUpdateWorkspaceSharing();
  const {
    cancel,
    cancelError,
    cancelling,
    control,
    inviteDisabled,
    inviteError,
    invitesData,
    invitesError,
    isClass,
    isSubmitting,
    membersData,
    membersError,
    onInvite,
    refetchInvites,
    refetchMembers,
    removing,
    roles,
    setRemoving,
    updated,
    updateMember,
    updatingRole,
  } = useMemberManager(workspace.id, canManage);
  const count = membersData?.length;
  const meta = [
    workspace.name,
    count === undefined
      ? null
      : count === 1
        ? m.workspace_members_one()
        : m.workspace_members_count({ count }),
  ]
    .filter(Boolean)
    .join(' · ');
  // Teaching assistant needs the room a class's role names take: on phones a
  // row's dropdown and button go under the name.
  const roleWidth = isClass ? 'w-44' : 'w-22 sm:w-24';
  const stacks = isClass && canManage;
  const roleName = (role: string) =>
    role === 'owner'
      ? m.common_owner()
      : roles.find((option) => option.value === role)?.label;
  return (
    <PracticeFrame>
      {header ?? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3">
          <h1 className="t-page-title">{m.study_panel_members()}</h1>
          <span className="t-meta mt-1.5 text-fg-muted">{meta}</span>
        </div>
      )}
      {/* First, as the settings page has it; a line then parts it from the
          invitation. An editor's list starts with its own top line. */}
      {shares && (
        <section aria-label={m.workspace_sharing()} className="tab-body-mt">
          <ShareDialog
            embedded
            link={workspace.sharePath}
            members={false}
            onClose={() => undefined}
            onPrivacyChange={(privacy) =>
              updateSharing({ id: workspace.id, privacy })
            }
            onShareRoleChange={(shareRole) =>
              updateSharing({ id: workspace.id, shareRole })
            }
            open
            privacy={workspace.privacy}
            saving={sharing}
            shareRole={workspace.shareRole}
            workspaceId={workspace.id}
          />
          {canManage && <Separator className="mt-6" />}
        </section>
      )}
      {canManage && (
        <>
          <form className="mt-6 flex flex-wrap gap-2" onSubmit={onInvite}>
            <Controller
              control={control}
              name="identifier"
              render={({ field, fieldState }) => (
                // Phones: the field on its own line, the role and Invite under
                // it, ending where the rows' buttons do.
                <div className="w-full sm:w-auto sm:min-w-48 sm:flex-1">
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
            <div className="ml-auto flex gap-2">
              <Controller
                control={control}
                name="role"
                render={({ field }) => (
                  <RoleSelect
                    className={roleWidth}
                    disabled={isSubmitting}
                    label={m.members_invite_role()}
                    onChange={field.onChange}
                    options={roles}
                    value={field.value as AssignableRole}
                  />
                )}
              />
              <Button
                className="w-20 sm:w-22"
                disabled={inviteDisabled}
                type="submit"
              >
                {isSubmitting ? <Spinner /> : m.members_invite()}
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
      <section aria-label={m.members_people()}>
        <ul
          className={cn(
            'border-divider border-t',
            shares && !canManage ? 'mt-6' : 'mt-3.5'
          )}
        >
          {membersData?.map((member) => (
            <li
              className={cn(
                'flex min-h-13 items-center gap-2 border-divider border-b py-1.5',
                stacks && 'flex-wrap sm:flex-nowrap'
              )}
              key={member.userId}
            >
              <Avatar
                className="size-7.5 shrink-0 text-xs"
                name={member.name}
                src={member.avatarUrl}
              />
              <p className="min-w-0 flex-1 truncate pl-1 font-semibold">
                {member.name}
                {member.userId === me?.id && (
                  <span className="t-meta ml-1.5 font-normal text-fg-muted">
                    {m.assignment_you()}
                  </span>
                )}
              </p>
              {canManage && member.role !== 'owner' ? (
                <div
                  className={cn(
                    'flex shrink-0 gap-2',
                    stacks && 'w-full justify-end sm:w-auto'
                  )}
                >
                  <RoleSelect
                    className={roleWidth}
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
                    className="w-20 sm:w-22"
                    onClick={() => setRemoving(member)}
                    variant="outline"
                  >
                    {m.action_remove()}
                  </Button>
                </div>
              ) : (
                <>
                  {/* The owner's own row keeps the dropdowns' column and text
                      edge, and the buttons' column empty. */}
                  <span
                    className={cn(
                      't-meta shrink-0 font-semibold text-fg-muted',
                      canManage &&
                        (stacks ? 'sm:w-44 sm:px-3' : cn(roleWidth, 'px-3'))
                    )}
                  >
                    {roleName(member.role)}
                  </span>
                  {canManage && (
                    <span
                      aria-hidden
                      className={cn(
                        'w-20 shrink-0 sm:w-22',
                        stacks && 'hidden sm:block'
                      )}
                    />
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
      {/* Every typed address, as typed and always as sent: whether one has an
          account never shows here. */}
      {canManage &&
        (!!invitesData?.length || (!invitesData && invitesError)) && (
          <section aria-labelledby="members-pending-title" className="mt-6">
            <h2 className="t-subtitle" id="members-pending-title">
              {m.members_pending_title()}
            </h2>
            {!invitesData && invitesError && (
              <InlineErrorState
                className="py-6"
                errorId={unexpectedErrorId(invitesError)}
                message={describeError(invitesError).title}
                onRetry={() => void refetchInvites()}
              />
            )}
            <ul className="mt-1.5 border-divider border-t">
              {invitesData?.map((pending) => (
                <li
                  className="flex min-h-13 items-center gap-2 border-divider border-b py-1.5"
                  key={pending.id}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{pending.address}</p>
                    <p className="t-meta text-fg-muted">
                      {m.members_pending_meta({
                        expires: inviteDay(pending.expiresAt),
                        sent: inviteDay(pending.sentAt),
                      })}
                    </p>
                  </div>
                  <Button
                    aria-label={m.members_pending_cancel_label({
                      address: pending.address,
                    })}
                    className="w-20 shrink-0 sm:w-22"
                    disabled={cancelling !== null}
                    onClick={() => void cancel(pending.id)}
                    variant="outline"
                  >
                    {cancelling === pending.id ? (
                      <Spinner />
                    ) : (
                      m.action_cancel()
                    )}
                  </Button>
                </li>
              ))}
            </ul>
            <FormAlert
              errorId={cancelError?.errorId}
              message={cancelError?.message ?? null}
            />
          </section>
        )}
      {removing && (
        <RemoveMemberDialog
          member={removing}
          onClose={() => setRemoving(null)}
          workspaceId={workspace.id}
        />
      )}
    </PracticeFrame>
  );
}
