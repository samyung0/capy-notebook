import { useNavigate, useParams } from '@tanstack/react-router';
import { isApiError, isWorkspaceLimitError } from '@/api/client';
import { useAcceptWorkspaceInvite } from '@/api/hooks';
import { showErrorToast } from '@/api/queryClient';
import { AuthGate } from '@/components/app/AuthProvider';
import { ErrorState } from '@/components/app/ErrorState';
import { Panel } from '@/components/app/layout';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Button, ErrorAction } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
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
      <Panel
        className="h-full w-full"
        sectionClassName="h-full w-full min-h-full flex items-center justify-center"
      >
        <AuthGate>
          <InviteContent />
        </AuthGate>
      </Panel>
    </main>
  );
}

function InviteContent() {
  const { token: param } = useParams({ strict: false }) as { token: string };
  // The boot module moved the token out of the address bar (urlTokenStash).
  const token = useStashedToken('invite', param);
  const navigate = useNavigate();
  const {
    data: acceptData,
    error,
    isPending: acceptIsPending,
    isSuccess: acceptIsSuccess,
    mutate: acceptMutation,
  } = useAcceptWorkspaceInvite();
  // Past the workspace cap (owned and joined together) the invite stays
  // open to accept after leaving or deleting one, and the limit is toasted.
  const acceptError = isWorkspaceLimitError(error) ? null : error;
  const acceptIsError = !!acceptError;
  // Used or refused: a retry keeps it in state, a refresh does not. A limit
  // refusal keeps the stash too, so Back or a refresh after upgrading from
  // the toast reopens the invite (Epo 2026-10-28).
  const accept = (value: string) =>
    acceptMutation(value, {
      onError: (refusal) => {
        if (isWorkspaceLimitError(refusal)) showErrorToast(refusal);
        else clearStashedToken('invite');
      },
      onSuccess: () => clearStashedToken('invite'),
    });

  if (
    !token ||
    (acceptIsError && isUnavailableWorkspaceInviteError(acceptError))
  ) {
    return (
      <WorkspaceError backLabel={m.workspace_back_to()} backTo="/workspaces" />
    );
  }

  if (acceptIsError) {
    return (
      <ErrorState
        {...describeError(acceptError)}
        action={
          <div className="flex gap-2">
            <Button
              onClick={() => navigate({ to: '/workspaces' })}
              variant="ghost-hover"
            >
              {m.action_cancel()}
            </Button>
            <ErrorAction
              disabled={acceptIsPending}
              onClick={() => accept(token)}
            >
              {m.error_action_retry()}
            </ErrorAction>
          </div>
        }
        testId="invite-accept-error"
        variant="page"
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="flex min-h-80 flex-col items-center justify-center px-6 py-12 text-center">
        <span className="mb-5 rounded-card bg-tint-accent-1 p-3 text-tint-accent-1-fg">
          <Icon className="size-6" name="workspaces" />
        </span>
        <h1 className="t-large-card-title">{m.invite_title()}</h1>
        <p className="mt-2 max-w-md text-fg-muted text-sm">{m.invite_body()}</p>

        {acceptIsSuccess ? (
          <Button
            className="mt-6"
            onClick={() =>
              navigate({
                params: { workspaceId: acceptData.workspaceId },
                to: '/workspaces/$workspaceId',
              })
            }
            variant="accent"
          >
            {m.invite_open()}
          </Button>
        ) : (
          <div className="mt-6 flex gap-2">
            <Button
              onClick={() => navigate({ to: '/workspaces' })}
              variant="ghost-hover"
            >
              {m.action_cancel()}
            </Button>
            <Button
              disabled={acceptIsPending || !token}
              onClick={() => accept(token)}
              variant="accent"
            >
              {acceptIsPending ? m.invite_accepting() : m.invite_accept()}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
