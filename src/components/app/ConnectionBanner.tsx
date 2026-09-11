import { useQuery } from '@tanstack/react-query';
import { qk } from '@/api/client';
import type { EventStreamState } from '@/api/hooks';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { useOnlineStatus } from '@/lib/online';

export function ConnectionBanner() {
  const online = useOnlineStatus();
  const { data: stream } = useQuery<EventStreamState>({
    enabled: false,
    meta: { errorBoundary: false },
    queryFn: async () => ({ status: 'connected' }),
    queryKey: qk.eventStream,
  });
  let message: string | null = null;
  if (online && stream?.status === 'disconnected')
    message = m.connection_reconnecting();
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
