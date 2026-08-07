import { useNavigate, useParams } from '@tanstack/react-router';
import { useAcceptWorkspaceInvite } from '@/api/hooks';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

export default function WorkspaceInviteAccept() {
  const { token } = useParams({ strict: false }) as { token: string };
  const navigate = useNavigate();
  const {
    data: acceptData,
    isError: acceptIsError,
    isPending: acceptIsPending,
    isSuccess: acceptIsSuccess,
    mutate: accept,
  } = useAcceptWorkspaceInvite();

  return (
    <PanelWithInvertedRadius className="mx-auto w-full max-w-xl">
      <div className="flex min-h-80 flex-col items-center justify-center px-6 py-12 text-center">
        <span className="mb-5 rounded-card bg-tint-accent-1 p-3 text-tint-accent-1-fg">
          <Icon className="size-6" name="workspaces" />
        </span>
        <h1 className="t-large-card-title">Workspace invitation</h1>
        <p className="mt-2 max-w-md text-fg-muted text-sm">
          Accept this invitation to join the workspace with the role selected by
          its owner.
        </p>

        {acceptIsError && (
          <p className="mt-5 text-sm text-solid-error" role="alert">
            This invitation is invalid, expired, revoked, or belongs to another
            account.
          </p>
        )}

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
            Open workspace
          </Button>
        ) : (
          <div className="mt-6 flex gap-2">
            <Button
              onClick={() => navigate({ to: '/workspaces' })}
              variant="ghost-hover"
            >
              Cancel
            </Button>
            <Button
              disabled={acceptIsPending || !token}
              onClick={() => accept(token)}
              variant="accent"
            >
              {acceptIsPending ? 'Accepting…' : 'Accept invitation'}
            </Button>
          </div>
        )}
      </div>
    </PanelWithInvertedRadius>
  );
}
