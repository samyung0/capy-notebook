import { useNavigate, useParams } from '@tanstack/react-router';
import { useAcceptWorkspaceInvite } from '@/api/hooks';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';

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
        <h1 className="t-large-card-title">{m.invite_title()}</h1>
        <p className="mt-2 max-w-md text-fg-muted text-sm">{m.invite_body()}</p>

        {acceptIsError && (
          <p className="mt-5 text-sm text-solid-error" role="alert">
            {m.invite_invalid()}
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
    </PanelWithInvertedRadius>
  );
}
