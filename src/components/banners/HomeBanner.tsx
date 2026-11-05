import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { qk } from '@/api/client';
import type { EventStreamState } from '@/api/hooks';
import { useMe } from '@/api/hooks';
import { AccountState, StorageUsageLevel } from '@/api/types';
import { storageLimitLabel, usagePercent } from '@/features/billing/format';
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
  /** Storage used, 0 to 100, for the meter. */
  usedPercent?: number;
};

/**
 * The viewer's own account or connection problem, if any, one at a time: frozen,
 * grace, full, near the limit, offline, reconnecting. Home's card and the
 * Dashboard's small one both read it.
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
      usedPercent: usagePercent(
        account.storageUsedBytes,
        0,
        account.storageLimitBytes
      ),
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

function SubscriptionLink() {
  return (
    <Button
      asChild
      className="h-7 px-2 text-fg underline underline-offset-3 hover:bg-fg/5"
      size="sm"
      variant="ghost"
    >
      <Link search={{ tab: 'subscription' }} to="/billing">
        {m.account_banner_subscription()}
      </Link>
    </Button>
  );
}

/** Home's banner slot, empty unless the viewer has an account status. */
export default function HomeBanner() {
  const status = useAccountStatus();
  if (!status) return null;
  return (
    <SlotCard
      body={status.body}
      connection={
        status.kind === 'offline' || status.kind === 'reconnecting'
          ? status.kind
          : undefined
      }
      icon={status.icon}
      title={status.title}
      tone={status.tone}
    >
      {status.usedPercent !== undefined && (
        <div
          aria-hidden
          className="mt-2.5 h-1.5 max-w-[260px] overflow-hidden rounded-full bg-current/18"
          data-testid="storage-usage-meter"
        >
          <div
            className="h-full rounded-full bg-current"
            style={{ width: `${status.usedPercent}%` }}
          />
        </div>
      )}
      {status.links && (
        <div className="mt-1.5 -ml-2">
          <SubscriptionLink />
        </div>
      )}
    </SlotCard>
  );
}

/**
 * The same status small, inside a workspace's Dashboard below its title (Epo
 * 2026-11-05, Q631): the same words and links, with no meter.
 */
export function AccountStatusBanner() {
  const status = useAccountStatus();
  if (!status) return null;
  return (
    <SlotCard
      body={status.body}
      connection={
        status.kind === 'offline' || status.kind === 'reconnecting'
          ? status.kind
          : undefined
      }
      icon={status.icon}
      kind={status.kind}
      small
      title={status.title}
      tone={status.tone}
    >
      {status.links && (
        <div className="-ml-2">
          <SubscriptionLink />
        </div>
      )}
    </SlotCard>
  );
}

function SlotCard({
  title,
  body,
  icon,
  tone,
  connection,
  kind,
  small,
  children,
}: {
  title: string;
  body: string;
  icon: IconName;
  tone: 'warning' | 'error';
  connection?: 'offline' | 'reconnecting';
  kind?: AccountStatus['kind'];
  small?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Card
      className={cn(
        'relative block min-h-fit overflow-hidden',
        small && 'px-4 py-3',
        tone === 'warning' &&
          'bg-tint-warning text-tint-warning-fg hover:bg-tint-warning',
        tone === 'error' &&
          'bg-tint-error text-tint-error-fg hover:bg-tint-error'
      )}
      data-connection-status={connection}
      data-kind={kind}
      data-testid={small ? 'account-status-banner' : undefined}
      radius="card-lg"
      role="status"
    >
      <div className="relative z-10 flex flex-col gap-1 xl:max-w-[80%]">
        <p className={cn('font-bold', !small && 't-subtitle')}>{title}</p>
        <p className={cn(small ? 't-meta' : 'mt-1')}>{body}</p>
        {children}
      </div>
      <Icon
        className="absolute -top-3 -right-4 opacity-15"
        name={icon}
        size={small ? 72 : 120}
        strokeWidth={1.3}
      />
    </Card>
  );
}
