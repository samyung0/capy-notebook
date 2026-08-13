import { useState } from 'react';
import type { Privacy, WorkspaceRole } from '@/api/types';
import { WarningBanner } from '@/components/banners/WarningBanner';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import type { IconName } from '@/components/ui/Icon';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Separator } from '@/components/ui/Separator';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { Input, InputTitle } from '../../components/ui/Input';
import { MATERIALMODE_ICON } from '../materials/materialIconMappings';
import { WorkspaceMemberManager } from './WorkspaceMemberManager';

type SharedRole = Exclude<WorkspaceRole, 'owner'>;
type SavingField = 'privacy' | 'shareRole';
type PendingDangerousChange =
  | { kind: 'privacy'; value: Privacy }
  | { kind: 'shareRole'; value: SharedRole };

function privacyOptions(forWorkspace: boolean): {
  value: Privacy;
  label: string;
  icon: IconName;
  hint: string;
}[] {
  return [
    {
      hint: forWorkspace ? m.share_invite_only_hint() : m.share_private_hint(),
      icon: 'lock',
      label: forWorkspace ? m.share_invite_only() : m.share_private(),
      value: 'private',
    },
    {
      hint: m.share_link_hint(),
      icon: 'link',
      label: m.share_link(),
      value: 'link',
    },
    {
      hint: m.share_public_hint(),
      icon: 'globe',
      label: m.share_public(),
      value: 'public',
    },
  ];
}

function sharedRoleOptions(): Array<{
  value: SharedRole;
  label: string;
  hint: string;
  icon: IconName;
}> {
  return [
    {
      hint: m.share_can_view_hint(),
      icon: MATERIALMODE_ICON['view'],
      label: m.share_can_view(),
      value: 'viewer',
    },
    {
      hint: m.share_can_comment_hint(),
      icon: MATERIALMODE_ICON['comment'],
      label: m.share_can_comment(),
      value: 'commenter',
    },
    {
      hint: m.share_can_edit_hint(),
      icon: MATERIALMODE_ICON['edit'],
      label: m.share_can_edit(),
      value: 'editor',
    },
  ];
}

function isPublicEditor(
  privacy: Privacy,
  shareRole: SharedRole | undefined
): boolean {
  return privacy === 'public' && shareRole === 'editor';
}

function toastShareSuccess() {
  userToast({
    title: m.share_updated(),
    variant: 'success',
  });
}

function toastShareError(err: unknown) {
  userToast({
    description: err instanceof Error ? err.message : m.source_try_again(),
    title: m.error_generic_title(),
    variant: 'error',
  });
}

/** Generic share dialog: pick a visibility (private / link / public) and copy
 * the share link. Used by workspaces, quizzes and flashcard decks. */
export function ShareDialog({
  open,
  onClose,
  title,
  privacy,
  onPrivacyChange,
  link,
  saving,
  workspaceId,
  shareRole,
  onShareRoleChange,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  privacy: Privacy;
  /** Prefer returning a Promise (e.g. mutateAsync) so success/error toasts work. */
  onPrivacyChange: (privacy: Privacy) => void | Promise<unknown>;
  /** Absolute or app-relative URL viewers should open. */
  link: string;
  saving?: boolean;
  /** Enables workspace member management and link/public material permissions. */
  workspaceId?: string;
  shareRole?: SharedRole;
  onShareRoleChange?: (role: SharedRole) => void | Promise<unknown>;
}) {
  const [copied, setCopied] = useState(false);
  const [savingField, setSavingField] = useState<SavingField | null>(null);
  const [pendingDangerous, setPendingDangerous] =
    useState<PendingDangerousChange | null>(null);
  const busy = Boolean(saving) || savingField !== null;
  const options = privacyOptions(!!workspaceId);
  const roleOptions = sharedRoleOptions();
  const current = options.find((o) => o.value === privacy) ?? options[0];
  const currentRole =
    roleOptions.find((option) => option.value === shareRole) ?? roleOptions[0];
  const roleHint =
    privacy === 'public' && currentRole.value === 'editor'
      ? m.share_public_edit_anyone()
      : currentRole.hint;
  const absoluteLink = link.startsWith('http')
    ? link
    : `${window.location.origin}${link}`;
  const publicEditorActive = isPublicEditor(privacy, shareRole);

  async function copy() {
    try {
      await navigator.clipboard.writeText(absoluteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      userToast({
        button: { label: m.action_dismiss(), onClick: () => {} },
        description: absoluteLink,
        title: m.share_copy_failed(),
      });
    }
  }

  async function applyPrivacyChange(next: Privacy) {
    setSavingField('privacy');
    try {
      await onPrivacyChange(next);
      toastShareSuccess();
    } catch (err) {
      toastShareError(err);
    } finally {
      setSavingField(null);
    }
  }

  async function applyShareRoleChange(next: SharedRole) {
    if (!onShareRoleChange) return;
    setSavingField('shareRole');
    try {
      await onShareRoleChange(next);
      toastShareSuccess();
    } catch (err) {
      toastShareError(err);
    } finally {
      setSavingField(null);
    }
  }

  function handlePrivacyChange(next: Privacy) {
    if (next === privacy || busy) return;
    if (isPublicEditor(next, shareRole)) {
      setPendingDangerous({ kind: 'privacy', value: next });
      return;
    }
    void applyPrivacyChange(next);
  }

  function handleShareRoleChange(next: SharedRole) {
    if (!onShareRoleChange || next === shareRole || busy) return;
    if (isPublicEditor(privacy, next)) {
      setPendingDangerous({ kind: 'shareRole', value: next });
      return;
    }
    void applyShareRoleChange(next);
  }

  function confirmDangerousChange() {
    if (!pendingDangerous) return;
    const pending = pendingDangerous;
    setPendingDangerous(null);
    if (pending.kind === 'privacy') void applyPrivacyChange(pending.value);
    else void applyShareRoleChange(pending.value);
  }

  const confirmingDangerous = pendingDangerous !== null;

  return (
    <SimpleDialog
      onClose={() => {
        if (confirmingDangerous) return;
        onClose();
      }}
      onEscapeKeyDown={(e) => {
        if (confirmingDangerous) e.preventDefault();
      }}
      onInteractOutside={(e) => {
        if (confirmingDangerous) e.preventDefault();
      }}
      onPointerDownOutside={(e) => {
        if (confirmingDangerous) e.preventDefault();
      }}
      open={open}
      title={title ?? m.action_share()}
    >
      <div className="flex flex-col gap-6">
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <InputTitle>{m.share_visibility()}</InputTitle>
            <p className="t-meta text-fg-muted">{current.hint}</p>
          </div>
          <div className="min-w-45 max-w-70">
            <Select
              disabled={busy}
              onValueChange={(v) => handlePrivacyChange(v as Privacy)}
              value={privacy}
            >
              <SelectTrigger
                aria-label={m.share_visibility()}
                loading={savingField === 'privacy'}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {options.map((o) => (
                    <SelectItem
                      className={
                        o.value === 'public' && shareRole === 'editor'
                          ? 'text-tint-error-fg hover:bg-tint-error'
                          : undefined
                      }
                      iconAndValue={o}
                      key={o.value}
                      value={o.value}
                    />
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
        {workspaceId &&
          privacy !== 'private' &&
          shareRole &&
          onShareRoleChange && (
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <InputTitle>{m.share_anyone_with_access()}</InputTitle>
                <p className="t-meta text-fg-muted">{roleHint}</p>
              </div>
              <div className="min-w-45 max-w-70">
                <Select
                  disabled={busy}
                  onValueChange={(value) =>
                    handleShareRoleChange(value as SharedRole)
                  }
                  value={shareRole}
                >
                  <SelectTrigger
                    aria-label={m.share_anyone_with_access()}
                    loading={savingField === 'shareRole'}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {roleOptions.map((option) => (
                        <SelectItem
                          className={
                            option.value === 'editor' && privacy === 'public'
                              ? 'text-tint-error-fg hover:bg-tint-error'
                              : undefined
                          }
                          iconAndValue={option}
                          key={option.value}
                          value={option.value}
                        />
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        {publicEditorActive && (
          <WarningBanner message={m.share_public_edit_warning()} />
        )}
        {privacy !== 'private' && (
          <div className="flex items-center gap-3.5">
            <Input
              disabled
              type="text"
              value={absoluteLink}
              wrapperClassName="has-disabled:pointer-events-auto has-disabled:cursor-auto flex-1"
            />
            <Button
              className="rounded-input"
              iconLeft={copied ? 'check' : 'link'}
              onClick={copy}
              variant="outline"
            >
              {copied ? m.action_copied() : m.action_copy()}
            </Button>
          </div>
        )}
        {workspaceId && open && (
          <>
            <Separator />
            <WorkspaceMemberManager workspaceId={workspaceId} />
          </>
        )}
      </div>
      <ConfirmDialog
        body={m.share_public_edit_warning()}
        confirmLabel={m.action_confirm()}
        danger
        onClose={() => setPendingDangerous(null)}
        onConfirm={confirmDangerousChange}
        open={confirmingDangerous}
        title={m.share_public_edit_title()}
      />
    </SimpleDialog>
  );
}
