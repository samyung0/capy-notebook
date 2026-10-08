import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { qk } from '@/api/client';
import type { EventStreamState } from '@/api/hooks';
import { useMe } from '@/api/hooks';
import { AccountState, StorageUsageLevel } from '@/api/types';
import { storageLimitLabel, usagePercent } from '@/features/billing/format';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { COVER_COLORS, mixedSymbolsArt } from '@/lib/coverArt';
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

/**
 * The dashboard's banner slot. The viewer's own account and connection
 * problems take the default banner's place, one at a time (frozen, grace,
 * full, near the limit, offline, reconnecting), so nothing shifts the app shell.
 */
export default function DashboardBanner() {
  const { data: me } = useMe({ errorBoundary: false });
  const online = useOnlineStatus();
  const { data: stream } = useQuery<EventStreamState>({
    enabled: false,
    meta: { errorBoundary: false },
    queryFn: async () => ({ status: 'connected' }),
    queryKey: qk.eventStream,
  });
  const account = me?.account;
  const graceDate = formatDate(account?.graceEndsAt);
  const accountLinks = (
    <div className="mt-1.5 -ml-2 flex flex-wrap gap-1">
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
      <Button
        asChild
        className="h-7 px-2 text-fg underline underline-offset-3 hover:bg-fg/5"
        size="sm"
        variant="ghost"
      >
        <Link to="/settings">{m.account_banner_settings()}</Link>
      </Button>
    </div>
  );

  if (account?.state === AccountState.over_quota_frozen)
    return (
      <SlotCard
        body={m.account_banner_frozen_body()}
        icon="error"
        title={m.account_banner_frozen_title()}
        tone="error"
      >
        {accountLinks}
      </SlotCard>
    );
  if (account?.state === AccountState.over_quota_grace)
    return (
      <SlotCard
        body={
          graceDate
            ? m.account_banner_grace_body({ date: graceDate })
            : m.account_banner_grace_body_nodate()
        }
        icon="database"
        title={m.account_banner_grace_title()}
        tone="warning"
      >
        {accountLinks}
      </SlotCard>
    );
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
    return (
      <SlotCard
        body={
          full
            ? m.account_banner_full_body(amounts)
            : m.account_banner_near_body(amounts)
        }
        icon="database"
        title={
          full ? m.account_banner_full_title() : m.account_banner_near_title()
        }
        tone={full ? 'error' : 'warning'}
      >
        <div
          aria-hidden
          className="mt-2.5 h-1.5 max-w-[260px] overflow-hidden rounded-full bg-current/18"
          data-testid="storage-usage-meter"
        >
          <div
            className="h-full rounded-full bg-current"
            style={{
              width: `${usagePercent(account.storageUsedBytes, 0, account.storageLimitBytes)}%`,
            }}
          />
        </div>
        {accountLinks}
      </SlotCard>
    );
  }
  if (!online || stream?.status === 'disconnected')
    return (
      <SlotCard
        body={
          online
            ? m.connection_reconnecting_body()
            : m.connection_offline_body()
        }
        connection={online ? 'reconnecting' : 'offline'}
        icon="wifiOff"
        title={
          online
            ? m.connection_reconnecting_title()
            : m.connection_offline_title()
        }
        tone="warning"
      />
    );
  return <DefaultBanner />;
}

/** The slot's resting banner: a cover strip of mixed subject symbols (mock D1c). */
function DefaultBanner() {
  const image = useMemo(() => mixedSymbolsArt('dashboard'), []);
  return (
    <div
      className="relative min-h-fit shrink-0 overflow-hidden rounded-card-lg p-5.5 text-white"
      style={{
        backgroundColor: COVER_COLORS[0],
        backgroundImage: image,
        backgroundPosition: 'center',
        backgroundSize: 'cover',
      }}
    >
      <span
        aria-hidden
        className="absolute inset-0 bg-linear-to-r from-black/30 to-transparent"
      />
      <div className="relative flex flex-col gap-1 xl:max-w-[80%]">
        <p className="t-subtitle font-bold">{m.dashboard_banner_title()}</p>
        <p className="mt-1 text-white/90">{m.dashboard_banner_body()}</p>
      </div>
    </div>
  );
}

function SlotCard({
  title,
  body,
  icon,
  tone,
  connection,
  children,
}: {
  title: string;
  body: string;
  icon: IconName;
  tone: 'warning' | 'error';
  connection?: 'offline' | 'reconnecting';
  children?: React.ReactNode;
}) {
  return (
    <Card
      className={cn(
        'relative block min-h-fit overflow-hidden',
        tone === 'warning' &&
          'bg-tint-warning text-tint-warning-fg hover:bg-tint-warning',
        tone === 'error' &&
          'bg-tint-error text-tint-error-fg hover:bg-tint-error'
      )}
      data-connection-status={connection}
      radius="card-lg"
      role="status"
    >
      <div className="relative z-10 flex flex-col gap-1 xl:max-w-[80%]">
        <p className="t-subtitle font-bold">{title}</p>
        <p className="mt-1">{body}</p>
        {children}
      </div>
      <Icon
        className="absolute -top-3 -right-4 opacity-15"
        name={icon}
        size={120}
        strokeWidth={1.3}
      />
    </Card>
  );
}
