import { useQuery } from '@tanstack/react-query';
import { useOpsApp } from '@/app-context';
import {
  ErrorState,
  MetricCard,
  PageHeader,
  PageLoading,
} from '@/components/common';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatCount, formatDateTime, percent } from '@/format';

export function HealthPage() {
  const { api } = useOpsApp();
  const { data, error, isPending, refetch } = useQuery({
    queryFn: api.health,
    queryKey: ['health'],
    refetchInterval: 30_000,
  });

  if (isPending) {
    return <PageLoading label="Loading system health" />;
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }

  const reservationTotal =
    data.reservationRatio24h.settled + data.reservationRatio24h.released;

  return (
    <>
      <PageHeader
        description="Billing integrity, background work, and delivery checks. Refreshes every 30 seconds."
        title="System health"
      />

      <section
        aria-label="Health checks"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <MetricCard
          detail="Open reservations past their expiry"
          label="Expired reservations"
          tone={data.expiredReservations > 0 ? 'danger' : 'success'}
          value={formatCount(data.expiredReservations)}
        />
        <MetricCard
          detail={data.rollupStale ? 'Missing or stale' : 'Current'}
          label="Rollup staleness"
          tone={data.rollupStale ? 'danger' : 'success'}
          value={data.rollupStale ? 'Stale' : 'Current'}
        />
        <MetricCard
          detail="Running past the configured threshold"
          label="Stuck jobs"
          tone={data.stuckJobs > 0 ? 'danger' : 'success'}
          value={formatCount(data.stuckJobs)}
        />
        <MetricCard
          detail="Last 24 hours"
          label="Failed email"
          tone={data.emailFailures24h > 0 ? 'warning' : 'success'}
          value={formatCount(data.emailFailures24h)}
        />
        <MetricCard
          detail="Assistant turns without a usage event, last 24 hours"
          label="Unbilled assistant turns"
          tone={data.usageMissing24h > 0 ? 'danger' : 'success'}
          value={formatCount(data.usageMissing24h)}
        />
        <MetricCard
          detail={`${formatCount(data.reservationRatio24h.released)} released of ${formatCount(reservationTotal)}`}
          label="Settle / release ratio"
          tone={
            reservationTotal > 0 && data.reservationRatio24h.releaseRate > 0.2
              ? 'warning'
              : 'neutral'
          }
          value={`${percent(data.reservationRatio24h.settled, reservationTotal)} / ${percent(data.reservationRatio24h.released, reservationTotal)}`}
        />
      </section>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Usage rollup</CardTitle>
          <CardDescription>
            The daily rollup should complete once per UTC day.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-muted-foreground text-sm">
            Last completed run
          </span>
          <span className="font-medium tabular-nums">
            {formatDateTime(data.rollupLastRunAt)}
          </span>
        </CardContent>
      </Card>
    </>
  );
}
