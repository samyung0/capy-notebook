import { useQuery } from '@tanstack/react-query';
import { Navigate, useParams } from '@tanstack/react-router';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { PaneLoading } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { redeemShareToken } from '@/lib/shareRedeem';
import { clearStashedToken } from '@/lib/urlTokenStash';
import { useStashedToken } from '@/lib/useStashedToken';

/** `/open/{token}`, a summary page's Open: presents the share link once for
 * the signed-in viewer (Google's resource key, Sam 2026-10-18), then opens
 * the workspace or material by id. A forged token or a private resource shows
 * the private-workspace panel. */
export default function OpenShareLink() {
  const { token: param } = useParams({ strict: false }) as { token: string };
  // The boot module moved the token out of the address bar (urlTokenStash).
  const token = useStashedToken('open', param);
  const { data, isError } = useQuery({
    enabled: !!token,
    meta: { errorBoundary: false },
    // Used or refused: it has no further use in this tab.
    queryFn: () =>
      redeemShareToken(token).finally(() => clearStashedToken('open')),
    queryKey: ['share-redeem', token],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (isError || !token)
    return (
      <WorkspaceError backLabel={m.workspace_back_to()} backTo="/workspaces" />
    );
  if (!data) return <PaneLoading message={m.common_loading()} />;
  return data.kind === 'workspace' ? (
    <Navigate
      params={{ workspaceId: data.id }}
      replace
      to="/workspaces/$workspaceId"
    />
  ) : (
    <Navigate
      params={{ materialId: data.id }}
      replace
      to="/materials/$materialId"
    />
  );
}
