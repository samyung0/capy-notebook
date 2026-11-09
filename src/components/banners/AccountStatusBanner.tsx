import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { qk } from '@/api/client';
import type { EventStreamState } from '@/api/hooks';
import { useMe } from '@/api/hooks';
import { AccountState, StorageUsageLevel } from '@/api/types';
import { storageLimitLabel } from '@/features/billing/format';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useOnlineStatus } from '@/lib/online';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Icon, type IconName } from '../ui/Icon';

function formatDate(iso?: string) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(getLocale(), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

type AccountStatus = {
  body: string;
  icon: IconName;
  kind: 'frozen' | 'grace' | 'full' | 'near' | 'offline' | 'reconnecting';
  /** It carries the Subscription link. */
  links: boolean;
  title: string;
  tone: 'warning' | 'error';
};

/**
 * The viewer's own account or connection problem, if any, one at a time: frozen,
 * grace, full, near the limit, offline, reconnecting.
 */
function useAccountStatus(): AccountStatus | null {
  const { data: me } = useMe({ errorBoundary: false });
  const online = useOnlineStatus();
  const { data: stream } = useQuery<EventStreamState>({
    enabled: false,
    meta: { errorBoundary: false },
    queryFn: async () => ({ status: 'connected' }),
    queryKey: qk.eventStream,
  });
  const account = me?.account;
  if (account?.state === AccountState.over_quota_frozen)
    return {
      body: m.account_banner_frozen_body(),
      icon: 'error',
      kind: 'frozen',
      links: true,
      title: m.account_banner_frozen_title(),
      tone: 'error',
    };
  if (account?.state === AccountState.over_quota_grace) {
    const graceDate = formatDate(account.graceEndsAt);
    return {
      body: graceDate
        ? m.account_banner_grace_body({ date: graceDate })
        : m.account_banner_grace_body_nodate(),
      icon: 'database',
      kind: 'grace',
      links: true,
      title: m.account_banner_grace_title(),
      tone: 'warning',
    };
  }
  const usage = account?.storageUsage;
  if (
    account &&
    (usage === StorageUsageLevel.full || usage === StorageUsageLevel.near_limit)
  ) {
    const full = usage === StorageUsageLevel.full;
    // Whole megabytes, rounded down so 95% never reads as the full limit.
    const amounts = {
      limit: storageLimitLabel(account.storageLimitBytes),
      used: `${Math.floor(account.storageUsedBytes / 1_000_000)} MB`,
    };
    return {
      body: full
        ? m.account_banner_full_body(amounts)
        : m.account_banner_near_body(amounts),
      icon: 'database',
      kind: full ? 'full' : 'near',
      links: true,
      title: full
        ? m.account_banner_full_title()
        : m.account_banner_near_title(),
      tone: full ? 'error' : 'warning',
    };
  }
  if (!online)
    return {
      body: m.connection_offline_body(),
      icon: 'wifiOff',
      kind: 'offline',
      links: false,
      title: m.connection_offline_title(),
      tone: 'warning',
    };
  if (stream?.status === 'disconnected')
    return {
      body: m.connection_reconnecting_body(),
      icon: 'wifiOff',
      kind: 'reconnecting',
      links: false,
      title: m.connection_reconnecting_title(),
      tone: 'warning',
    };
  return null;
}

/**
 * The viewer's account status, small, below the title of a workspace's Dashboard
 * and of Workspaces (Epo 2026-11-05, Q631); nothing without one.
 */
export function AccountStatusBanner() {
  const status = useAccountStatus();
  if (!status) return null;
  return (
    <Card
      className={cn(
        'relative block min-h-fit overflow-hidden px-4 py-3',
        status.tone === 'warning' &&
          'bg-tint-warning text-tint-warning-fg hover:bg-tint-warning',
        status.tone === 'error' &&
          'bg-tint-error text-tint-error-fg hover:bg-tint-error'
      )}
      data-connection-status={
        status.kind === 'offline' || status.kind === 'reconnecting'
          ? status.kind
          : undefined
      }
      data-kind={status.kind}
      data-testid="account-status-banner"
      radius="card-lg"
      role="status"
    >
      {/* Phones put the action on its own row, right-aligned. */}
      <div className="relative z-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-bold">{status.title}</p>
          <p className="t-meta">{status.body}</p>
        </div>
        {status.links && (
          <div className="shrink-0 self-end sm:self-auto">
            <Button asChild size="sm">
              <Link search={{ tab: 'subscription' }} to="/billing">
                {m.account_banner_subscription()}
              </Link>
            </Button>
          </div>
        )}
      </div>
      <Icon
        className="absolute -top-3 -right-4 opacity-15"
        name={status.icon}
        size={72}
        strokeWidth={1.3}
      />
    </Card>
  );
}
