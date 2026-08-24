import { useQuery } from '@tanstack/react-query';
import { useOpsApp } from './app-context';
import {
  ErrorState,
  formatDateTime,
  formatNumber,
  MetricCard,
  PageHeader,
  PageSkeleton,
  POLL_INTERVAL,
} from './ops-ui';

export function HealthPage() {
  const { api } = useOpsApp();
  const { data, error, isError, isPending, refetch } = useQuery({
    queryFn: api.health,
    queryKey: ['ops', 'health'],
    refetchInterval: POLL_INTERVAL,
  });

  if (isPending) {
    return <PageSkeleton />;
  }
  if (isError || !data) {
    return <ErrorState error={error} onRetry={() => refetch()} />;
  }

  const totalReservations =
    data.reservationRatio24h.settled + data.reservationRatio24h.released;
  const releaseRate =
    data.reservationRatio24h.releaseRate ??
    (totalReservations === 0
      ? 0
      : data.reservationRatio24h.released / totalReservations);
  const rollupAge = data.rollupLastRunAt
    ? Date.now() - new Date(data.rollupLastRunAt).getTime()
    : Number.POSITIVE_INFINITY;
  const rollupStale = data.rollupStale ?? rollupAge > 45 * 60 * 1000;

  return (
    <div className="space-y-6">
      <PageHeader
        description="Failures that can silently freeze reporting, leak spend, or strand work."
        title="Health"
      />
      <section
        aria-label="Health checks"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <MetricCard
          detail="Open credit holds past their expiry time"
          label="Expired reservations"
          tone={data.expiredReservations > 0 ? 'danger' : 'success'}
          value={formatNumber(data.expiredReservations)}
        />
        <MetricCard
          detail={`Last ran ${formatDateTime(data.rollupLastRunAt)}`}
          label="Usage rollup"
          tone={rollupStale ? 'danger' : 'success'}
          value={rollupStale ? 'Stale' : 'Current'}
        />
        <MetricCard
          detail="Running jobs beyond the worker threshold"
          label="Stuck jobs"
          tone={data.stuckJobs > 0 ? 'danger' : 'success'}
          value={formatNumber(data.stuckJobs)}
        />
        <MetricCard
          detail="Outbox rows failed during the last 24 hours"
          label="Email failures"
          tone={data.emailFailures24h > 0 ? 'warning' : 'success'}
          value={formatNumber(data.emailFailures24h)}
        />
        <MetricCard
          detail="Completed assistant turns with no metering event"
          label="Unmetered assistant turns"
          tone={data.usageMissing24h > 0 ? 'danger' : 'success'}
          value={formatNumber(data.usageMissing24h)}
        />
        <MetricCard
          detail={`${formatNumber(data.reservationRatio24h.settled)} settled, ${formatNumber(data.reservationRatio24h.released)} released`}
          label="Reservation release rate"
          tone={releaseRate > 0.1 ? 'warning' : 'success'}
          value={new Intl.NumberFormat('en-US', {
            maximumFractionDigits: 1,
            style: 'percent',
          }).format(releaseRate)}
        />
      </section>
    </div>
  );
}
