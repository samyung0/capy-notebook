import { useNavigate, useParams } from '@tanstack/react-router';
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
import { Button, ErrorAction } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/feedback';
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
      <ErrorState
        {...describeError(failure)}
        action={
          <div className="flex gap-2">
            <Button onClick={() => navigate({ to: '/' })} variant="ghost-hover">
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
    );
  }

  if (!preview) return <Spinner />;

  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="flex min-h-80 flex-col items-center justify-center px-6 py-12 text-center">
        <span className="mb-5 rounded-card bg-tint-accent-1 p-3 text-tint-accent-1-fg">
          <Icon className="size-6" name="workspaces" />
        </span>
        <h1 className="t-large-card-title">{m.invite_title()}</h1>
        <p className="mt-2 max-w-md text-fg-muted text-sm">{m.invite_body()}</p>
        {sharesProgress && (
          <div className="mt-5 max-w-md text-sm">
            <p className="text-fg-muted">{m.invite_sharing_consent()}</p>
            <p className="mt-2.5 inline-flex gap-2.5">
              <Icon
                className="mt-0.5 shrink-0 text-fg-muted"
                name="view"
                size={18}
              />
              {m.invite_sharing_progress()}
            </p>
          </div>
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
  );
}
