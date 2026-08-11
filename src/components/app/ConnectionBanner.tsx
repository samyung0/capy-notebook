import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { qk } from '@/api/client';
import type { IngestStreamState } from '@/api/hooks';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { useOnlineStatus } from '@/lib/online';

type StreamState = {
  status: 'connecting' | 'connected' | 'disconnected';
};

const WORKSPACE_PATH_PATTERN = /^\/workspaces\/([^/]+)$/;

export function ConnectionBanner() {
  const online = useOnlineStatus();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const workspaceId = WORKSPACE_PATH_PATTERN.exec(pathname)?.[1] ?? '';
  const { data: notificationStream } = useQuery<StreamState>({
    enabled: false,
    meta: { errorBoundary: false },
    queryFn: async () => ({ status: 'connecting' }),
    queryKey: qk.notificationStream,
  });
  const { data: ingestStream } = useQuery<IngestStreamState>({
    enabled: false,
    meta: { errorBoundary: false },
    queryFn: async () => ({ status: 'connecting' }),
    queryKey: qk.ingestStream(workspaceId),
  });
  const disconnected =
    notificationStream?.status === 'disconnected' ||
    (!!workspaceId && ingestStream?.status === 'disconnected');
  let message: string | null = null;
  if (online && disconnected) message = m.connection_reconnecting();
  if (!online) message = m.connection_offline();

  if (!message) return null;
  return (
    <div
      className="mb-2 flex items-center gap-2 rounded-card border border-tint-warning bg-tint-warning px-4 py-2 text-sm text-tint-warning-fg"
      data-connection-status={online ? 'reconnecting' : 'offline'}
      role="status"
    >
      <Icon className="size-4 shrink-0" name="warning" />
      <p>{message}</p>
    </div>
  );
}
