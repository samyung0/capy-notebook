import { useNavigate, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { isApiError, isWorkspaceLimitError } from '@/api/client';
import {
  useAcceptWorkspaceInvite,
  useWorkspaceInvitePreview,
} from '@/api/hooks';
import { showErrorToast } from '@/api/queryClient';
import { AuthGate } from '@/components/app/AuthProvider';
import { ErrorState } from '@/components/app/ErrorState';
import { Panel } from '@/components/app/layout';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Avatar } from '@/components/ui/Avatar';
import { Button, ErrorAction } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { describeError, isNonDisclosing } from '@/lib/errors';
import { clearStashedToken } from '@/lib/urlTokenStash';
import { useStashedToken } from '@/lib/useStashedToken';

export function isUnavailableWorkspaceInviteError(error: unknown): boolean {
  // The reader's own frozen account and workspace cap are theirs to hear
  // about.
  return (
    isNonDisclosing(error) &&
    !(isApiError(error) && error.code === 'account_over_quota') &&
    !isWorkspaceLimitError(error)
  );
}

export default function WorkspaceInviteAccept() {
  return (
    <main className="h-dvh overflow-hidden p-1.5 sm:p-2.5">
      <AuthGate>
        <InviteContent />
      </AuthGate>
    </main>
  );
}

/** The page's one panel; an unavailable invite's WorkspaceError brings its
 * own, so it is not drawn inside this one. */
function InvitePanel({ children }: { children: ReactNode }) {
  return (
    <Panel
      className="h-full w-full"
      sectionClassName="h-full w-full min-h-full flex items-center justify-center"
    >
      {children}
    </Panel>
  );
}

function InviteContent() {
  const { token: param } = useParams({ strict: false }) as { token: string };
  // The boot module moved the token out of the address bar (urlTokenStash).
  const token = useStashedToken('invite', param);
  const navigate = useNavigate();
  const {
    data: preview,
    error: previewError,
    refetch: refetchPreview,
  } = useWorkspaceInvitePreview(token);
  const {
    error,
    isPending: acceptIsPending,
    isSuccess: acceptIsSuccess,
    mutate: acceptMutation,
  } = useAcceptWorkspaceInvite();
  // Past the workspace cap (owned and joined together) the invite stays
  // open to accept after leaving or deleting one, and the limit is toasted.
  const acceptError = isWorkspaceLimitError(error) ? null : error;
  const failure = acceptError ?? previewError;
  // A class's member agrees to what they share before joining, and Accept
  // goes straight in (Epo 2026-11-19).
  const sharesProgress =
    preview?.workspaceKind === 'class' && preview.role === 'viewer';
  // Used or refused: a retry keeps it in state, a refresh does not. A limit
  // refusal keeps the stash too, so Back or a refresh after upgrading from
  // the toast reopens the invite (Epo 2026-10-28).
  const accept = (value: string) =>
    acceptMutation(value, {
      onError: (refusal) => {
        if (isWorkspaceLimitError(refusal)) showErrorToast(refusal);
        else clearStashedToken('invite');
      },
      onSuccess: (member) => {
        clearStashedToken('invite');
        navigate({
          params: { workspaceId: member.workspaceId },
          replace: true,
          to: '/workspaces/$workspaceId',
        });
      },
    });

  if (!token || (failure && isUnavailableWorkspaceInviteError(failure))) {
    return <WorkspaceError backLabel={m.workspace_back_to()} backTo="/" />;
  }

  if (failure) {
    return (
      <InvitePanel>
        <ErrorState
          {...describeError(failure)}
          action={
            <div className="flex gap-2">
              <Button
                onClick={() => navigate({ to: '/' })}
                variant="ghost-hover"
              >
                {m.action_cancel()}
              </Button>
              <ErrorAction
                disabled={acceptIsPending}
                onClick={() => (acceptError ? accept(token) : refetchPreview())}
              >
                {m.error_action_retry()}
              </ErrorAction>
            </div>
          }
          testId="invite-accept-error"
          variant="page"
        />
      </InvitePanel>
    );
  }

  if (!preview)
    return (
      <InvitePanel>
        <Spinner />
      </InvitePanel>
    );

  return (
    <InvitePanel>
      <div className="mx-auto w-full max-w-xl">
        <div className="flex min-h-80 flex-col items-center justify-center px-6 py-12 text-center">
          <p className="t-card-title text-fg-muted">{m.invite_title()}</p>
          {/* What they join and whose it is (Epo 2026-11-25), the owner as the
            class's sharing notice showed one. */}
          <h1 className="t-large-card-title mt-1 max-w-md break-words">
            {preview.workspaceName}
          </h1>
          <p className="mt-2 flex min-w-0 max-w-md items-center gap-2 font-semibold text-fg-muted text-sm">
            <Avatar
              aria-hidden
              className="size-6 shrink-0 text-[10px]"
              name={preview.owner.name}
              src={preview.owner.avatarUrl || undefined}
            />
            <span className="truncate">{preview.owner.name}</span>
          </p>
          {sharesProgress && (
            <p className="mt-5 max-w-md text-sm">
              {m.invite_sharing_consent()}
            </p>
          )}

          <div className="mt-6 flex gap-2">
            <Button onClick={() => navigate({ to: '/' })} variant="ghost-hover">
              {m.action_cancel()}
            </Button>
            <Button
              disabled={acceptIsPending || acceptIsSuccess}
              onClick={() => accept(token)}
              variant="accent"
            >
              {acceptIsPending || acceptIsSuccess
                ? m.invite_accepting()
                : m.invite_accept()}
            </Button>
          </div>
        </div>
      </div>
    </InvitePanel>
  );
}
