import { useQuery } from '@tanstack/react-query';
import type { Health } from '@/api';
import { useOpsApp } from '@/app-context';
import {
  ErrorState,
  FreshnessNote,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCount, formatDateTime, percent } from '@/format';

type TurnRow = Health['activeTurns'][number];

function TurnTable({
  description,
  empty,
  rows,
  title,
}: {
  description: string;
  empty: string;
  rows: TurnRow[];
  title: string;
}) {
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{empty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>User / trace</TableHead>
                <TableHead>Turn</TableHead>
                <TableHead>Reservation</TableHead>
                <TableHead>Latest call</TableHead>
                <TableHead className="text-right">
                  Applied / open / abandoned
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.messageId}>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(row.startedAt)}
                  </TableCell>
                  <TableCell>
                    <span className="block font-mono text-xs">
                      {row.userId}
                    </span>
                    <span className="block max-w-56 truncate font-mono text-muted-foreground text-xs">
                      {row.traceId || 'No trace'}
                    </span>
                  </TableCell>
                  <TableCell>{row.status}</TableCell>
                  <TableCell>
                    {row.reservationStatus || 'Missing'}
                    {row.surface ? ` · ${row.surface}` : ''}
                  </TableCell>
                  <TableCell>
                    {row.latestCallStatus || 'No call'}
                    {row.latestCallPurpose ? ` · ${row.latestCallPurpose}` : ''}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.appliedCalls} / {row.openCalls} / {row.abandonedCalls}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function HealthPage() {
  const { api } = useOpsApp();
  const { data, error, isPending, refetch } = useQuery({
    queryFn: api.health,
    queryKey: ['health'],
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
        actions={
          <FreshnessNote>
            Live database checks, refreshed every 30 seconds.
          </FreshnessNote>
        }
        description={`Billing integrity, turn lifecycle, background work, and delivery checks. Data as of ${formatDateTime(data.dataAsOf)}.`}
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
          detail="Streaming with an open, unexpired reservation"
          label="Active turns"
          value={formatCount(data.activeTurns.length)}
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
          detail="Completed turns without an applied LLM call, last 24 hours"
          label="Missing applied calls"
          tone={data.turnsMissingApplied24h > 0 ? 'danger' : 'success'}
          value={formatCount(data.turnsMissingApplied24h)}
        />
        <MetricCard
          detail="Applied calls without their atomic ledger row, last 24 hours"
          label="Settlement invariant"
          tone={data.appliedWithoutUsage24h > 0 ? 'danger' : 'success'}
          value={formatCount(data.appliedWithoutUsage24h)}
        />
        <MetricCard
          detail="LLM or embedding usage without its provider-call row, last 24 hours"
          label="Unlinked provider usage"
          tone={data.providerUsageWithoutCall24h > 0 ? 'danger' : 'success'}
          value={formatCount(data.providerUsageWithoutCall24h)}
        />
        <MetricCard
          detail="Provider calls still open after two minutes"
          label="Stale open calls"
          tone={data.staleOpenCalls > 0 ? 'warning' : 'success'}
          value={formatCount(data.staleOpenCalls)}
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
        <MetricCard
          detail="Streaming turns outside a healthy active lifecycle"
          label="Stale turns"
          tone={data.staleTurns.length > 0 ? 'danger' : 'success'}
          value={formatCount(data.staleTurns.length)}
        />
      </section>

      <TurnTable
        description="Streaming turns with an open, unexpired reservation. Open provider calls are shown separately when they become stale."
        empty="No active turns."
        rows={data.activeTurns}
        title="Active turns"
      />

      <TurnTable
        description="Streaming messages with a stale age, missing reservation, expired reservation, or closed reservation. Latest 50."
        empty="No stale or incomplete turns."
        rows={data.staleTurns}
        title="Stale and incomplete turns"
      />

      <TurnTable
        description="Assistant turns that ended with error or aborted status in the last 24 hours. Latest 50."
        empty="No failed or aborted turns."
        rows={data.failedTurns}
        title="Failed and aborted turns"
      />

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Busy models</CardTitle>
          <CardDescription>
            Attempts abandoned in the last hour on a provider 429, 503 or 529
            answer, by transport provider and model. This is the signal for
            tuning CAPY_MODEL_CONCURRENCY; a gate refusal writes no row.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.busyCalls.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No busy attempts in the last hour.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider / model</TableHead>
                  <TableHead className="text-right">Busy attempts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.busyCalls.map((row) => (
                  <TableRow key={`${row.provider}/${row.model}`}>
                    <TableCell className="font-mono text-xs">
                      {row.provider && row.model
                        ? `${row.provider} / ${row.model}`
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(row.calls)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Abandoned provider attempts</CardTitle>
          <CardDescription>
            Failed provider attempts from the last 24 hours. A completed turn
            means a later attempt recovered.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.abandonedCalls.length === 0 ? (
            <p className="text-muted-foreground text-sm">No abandoned calls.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Opened</TableHead>
                  <TableHead>User / trace</TableHead>
                  <TableHead>Purpose</TableHead>
                  <TableHead>Model / error</TableHead>
                  <TableHead>Turn outcome</TableHead>
                  <TableHead>Reservation</TableHead>
                  <TableHead className="text-right">Context estimate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.abandonedCalls.map((row) => (
                  <TableRow key={row.callId}>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(row.openedAt)}
                    </TableCell>
                    <TableCell>
                      <span className="block font-mono text-xs">
                        {row.userId}
                      </span>
                      <span className="block max-w-56 truncate font-mono text-muted-foreground text-xs">
                        {row.traceId || 'No trace'}
                      </span>
                    </TableCell>
                    <TableCell>
                      {row.purpose}
                      {row.thinking ? ` · ${row.thinking}` : ''}
                    </TableCell>
                    <TableCell>
                      <span className="block font-mono text-xs">
                        {row.provider && row.model
                          ? `${row.provider} / ${row.model}`
                          : '—'}
                      </span>
                      <span className="block text-muted-foreground text-xs">
                        {row.errorCode || '—'}
                      </span>
                    </TableCell>
                    <TableCell>{row.turnStatus || 'No turn'}</TableCell>
                    <TableCell>
                      {row.reservationStatus} · {row.surface}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.contextTotalTokens > 0 ? (
                        <span
                          title={`${row.contextCountingMethod} v${row.contextCountingVersion}; system / tools / conversation`}
                        >
                          <span className="block">
                            {formatCount(row.contextSystemTokens)} /{' '}
                            {formatCount(row.contextToolTokens)} /{' '}
                            {formatCount(row.contextConversationTokens)}
                          </span>
                          <span className="block text-muted-foreground text-xs">
                            {formatCount(row.contextTotalTokens)} of{' '}
                            {formatCount(row.contextWindowTokens)} tokens
                          </span>
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
