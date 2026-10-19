import { useQuery } from '@tanstack/react-query';
import { Navigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { PaneLoading } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { redeemShareToken } from '@/lib/shareRedeem';
import { clearStashedToken, stashedToken } from '@/lib/urlTokenStash';

/** `/open/{token}`, a summary page's Open: presents the share link once for
 * the signed-in viewer (Google's resource key, Sam 2026-10-18), then opens
 * the workspace or material by id. A forged token or a private resource shows
 * the private-workspace panel. */
export default function OpenShareLink() {
  const { token: param } = useParams({ strict: false }) as { token: string };
  // The boot module moved the token out of the address bar (urlTokenStash).
  const [token] = useState(() => stashedToken('open', param));
  const { data, isError } = useQuery({
    enabled: !!token,
    meta: { errorBoundary: false },
    queryFn: () => redeemShareToken(token),
    queryKey: ['share-redeem', token],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const settled = !!data || isError;
  // Used or refused: it has no further use in this tab.
  useEffect(() => {
    if (settled) clearStashedToken('open');
  }, [settled]);
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
