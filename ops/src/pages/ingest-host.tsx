import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useOpsApp } from '@/app-context';
import {
  EmptyState,
  ErrorState,
  FreshnessNote,
  MetricCard,
  PageHeader,
  PageLoading,
} from '@/components/common';
import { Badge } from '@/components/ui/badge';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatBytes, formatCount, formatDateTime, percent } from '@/format';

const GIB = 1024 ** 3;

function duration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${formatCount(milliseconds)} ms`;
  }
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(1)} s`;
  }
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function slowestStage(stageTimings: Record<string, number>): string {
  const slowest = Object.entries(stageTimings).sort(
    (left, right) => right[1] - left[1]
  )[0];
  return slowest ? `${slowest[0]} ${duration(slowest[1])}` : '';
}

const tooltipStyle = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
};

function statusVariant(status: string) {
  if (status === 'failed' || status === 'lease_expired') {
    return 'destructive' as const;
  }
  if (status === 'succeeded') {
    return 'secondary' as const;
  }
  return 'outline' as const;
}

export function IngestHostPage() {
  const { api } = useOpsApp();
  const [selectedEnvironment, setSelectedEnvironment] = useState('');
  const { data, error, isPending, refetch } = useQuery({
    queryFn: () => api.ingestHostMetrics(24),
    queryKey: ['ingest-host-metrics', 24],
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (
      data?.environments.length &&
      !data.environments.some(
        (environment) => environment.environment === selectedEnvironment
      )
    ) {
      setSelectedEnvironment(data.environments[0].environment);
    }
  }, [data?.environments, selectedEnvironment]);

  const environment =
    data?.environments.find(
      (item) => item.environment === selectedEnvironment
    ) ?? data?.environments[0];
  const hostRows = useMemo(
    () =>
      (environment?.samples ?? []).map((sample) => ({
        ...sample,
        hostMemoryGiB: sample.memoryUsedBytes / GIB,
        parserMemoryGiB: sample.parserMemoryBytes / GIB,
      })),
    [environment?.samples]
  );
  const workerRows = useMemo(() => {
    const buckets = new Map<
      string,
      {
        ingestCpu: number;
        ingestMemoryGiB: number;
        parseCpu: number;
        parseMemoryGiB: number;
        sampledAt: string;
      }
    >();
    for (const sample of environment?.workerSamples ?? []) {
      const row = buckets.get(sample.sampledAt) ?? {
        ingestCpu: 0,
        ingestMemoryGiB: 0,
        parseCpu: 0,
        parseMemoryGiB: 0,
        sampledAt: sample.sampledAt,
      };
      if (sample.role === 'parse') {
        row.parseCpu = sample.cpuCores;
        row.parseMemoryGiB = sample.memoryBytes / GIB;
      } else {
        row.ingestCpu = sample.cpuCores;
        row.ingestMemoryGiB = sample.memoryBytes / GIB;
      }
      buckets.set(sample.sampledAt, row);
    }
    return [...buckets.values()];
  }, [environment?.workerSamples]);

  if (isPending) {
    return <PageLoading label="Loading ingest telemetry" />;
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }
  if (!environment) {
    return (
      <EmptyState
        description="No ingest database is configured."
        title="No environments"
      />
    );
  }

  const latest = environment.samples.at(-1);
  const attempts = environment.attempts;
  const queue = environment.queue;
  const queued =
    queue.importReady +
    queue.importDelayed +
    queue.parseReady +
    queue.parseDelayed +
    queue.ingestReady +
    queue.ingestDelayed;
  const running =
    queue.importRunning + queue.parseRunning + queue.ingestRunning;

  return (
    <>
      <PageHeader
        actions={
          <FreshnessNote>
            Five-second active samples, sixty-second idle samples; raw 30 days,
            minute rollups one year.
          </FreshnessNote>
        }
        description={`Worker, queue, parser-pool, and per-attempt telemetry. ${environment.lastJobActivityAt ? `Last ${environment.environment} job activity ${formatDateTime(environment.lastJobActivityAt)}.` : `No ${environment.environment} job activity recorded.`} Data as of ${formatDateTime(data.dataAsOf)}.`}
        title="Ingest operations"
      />

      <Tabs
        onValueChange={setSelectedEnvironment}
        value={environment.environment}
      >
        <TabsList aria-label="Ingest environment">
          {data.environments.map((item) => (
            <TabsTrigger key={item.environment} value={item.environment}>
              {item.environment}
              {item.lastJobActivityAt ? '' : ' · no jobs'}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <section
        aria-label="Current ingest capacity"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <MetricCard
          detail={`${queue.importReady} import · ${queue.parseReady} parse · ${queue.ingestReady} ingest ready · oldest ${duration(queue.oldestQueuedMilliseconds)}`}
          label="Queued jobs"
          tone={
            queue.expiredLeases > 0
              ? 'danger'
              : queued > 0
                ? 'warning'
                : 'neutral'
          }
          value={formatCount(queued)}
        />
        <MetricCard
          detail={`${queue.importRunning} import · ${queue.parseRunning} parse · ${queue.ingestRunning} ingest · ${queue.expiredLeases} expired leases`}
          label="Running jobs"
          tone={queue.expiredLeases > 0 ? 'danger' : 'neutral'}
          value={formatCount(running)}
        />
        <MetricCard
          detail={`${attempts.retrying} retries · ${attempts.leaseExpired} lease expiries`}
          label="Failed attempts, 24h"
          tone={attempts.failed > 0 ? 'danger' : 'neutral'}
          value={formatCount(attempts.failed)}
        />
        <MetricCard
          detail={`${formatCount(attempts.ocrPages)} OCR · ${formatCount(attempts.slices)} slices`}
          label="Parsed pages, 24h"
          value={formatCount(attempts.pages)}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card className="min-w-0 shadow-sm">
          <CardHeader>
            <CardTitle>Parser pool and host</CardTitle>
            <CardDescription>
              MinerU is a shared pool, so its memory is deliberately not
              attributed to a lane. Local and UAT omit physical-host metrics.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {hostRows.length ? (
              <div
                aria-label="Parser pool resource chart"
                className="h-80"
                role="img"
              >
                <ResponsiveContainer height="100%" width="100%">
                  <LineChart
                    data={hostRows}
                    margin={{ left: 4, right: 12, top: 4 }}
                  >
                    <CartesianGrid
                      stroke="var(--border)"
                      strokeDasharray="3 3"
                    />
                    <XAxis
                      dataKey="sampledAt"
                      minTickGap={36}
                      tickFormatter={timeLabel}
                    />
                    <YAxis
                      tickFormatter={(value: number) =>
                        `${value.toFixed(0)} GiB`
                      }
                      width={62}
                      yAxisId="memory"
                    />
                    <YAxis
                      domain={[0, 100]}
                      orientation="right"
                      unit="%"
                      yAxisId="cpu"
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={timeLabel}
                    />
                    <Legend />
                    {latest?.hostMetricsAvailable ? (
                      <Line
                        dataKey="hostMemoryGiB"
                        dot={false}
                        name="Host used"
                        stroke="var(--chart-1)"
                        yAxisId="memory"
                      />
                    ) : null}
                    <Line
                      dataKey="parserMemoryGiB"
                      dot={false}
                      name="MinerU pool"
                      stroke="var(--chart-2)"
                      yAxisId="memory"
                    />
                    {latest?.hostMetricsAvailable ? (
                      <Line
                        dataKey="cpuPercent"
                        dot={false}
                        name="Host CPU %"
                        stroke="var(--chart-3)"
                        yAxisId="cpu"
                      />
                    ) : null}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState
                description="No host or parser-pool activity has been sampled."
                title="No pool samples"
              />
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 shadow-sm">
          <CardHeader>
            <CardTitle>Worker resources</CardTitle>
            <CardDescription>
              Per-container cgroup use, aggregated by parse coordinator and
              ingest worker role.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {workerRows.length ? (
              <div
                aria-label="Worker resource chart"
                className="h-80"
                role="img"
              >
                <ResponsiveContainer height="100%" width="100%">
                  <LineChart
                    data={workerRows}
                    margin={{ left: 4, right: 12, top: 4 }}
                  >
                    <CartesianGrid
                      stroke="var(--border)"
                      strokeDasharray="3 3"
                    />
                    <XAxis
                      dataKey="sampledAt"
                      minTickGap={36}
                      tickFormatter={timeLabel}
                    />
                    <YAxis yAxisId="cpu" />
                    <YAxis
                      orientation="right"
                      tickFormatter={(value: number) =>
                        `${value.toFixed(1)} GiB`
                      }
                      yAxisId="memory"
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={timeLabel}
                    />
                    <Legend />
                    <Line
                      dataKey="parseCpu"
                      dot={false}
                      name="Parse CPU cores"
                      stroke="var(--chart-1)"
                      yAxisId="cpu"
                    />
                    <Line
                      dataKey="ingestCpu"
                      dot={false}
                      name="Ingest CPU cores"
                      stroke="var(--chart-2)"
                      yAxisId="cpu"
                    />
                    <Line
                      dataKey="parseMemoryGiB"
                      dot={false}
                      name="Parse memory"
                      stroke="var(--chart-3)"
                      yAxisId="memory"
                    />
                    <Line
                      dataKey="ingestMemoryGiB"
                      dot={false}
                      name="Ingest memory"
                      stroke="var(--chart-4)"
                      yAxisId="memory"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState
                description="No worker activity has been sampled."
                title="No worker samples"
              />
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Attempt statistics, last 24 hours</CardTitle>
          <CardDescription>
            One row is recorded for every queue claim, including capacity waits
            that do not spend a visible retry.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            detail={`p95 ${duration(attempts.p95DurationMilliseconds)} · ${attempts.succeeded} succeeded`}
            label="Average duration"
            value={duration(attempts.averageDurationMilliseconds)}
          />
          <MetricCard
            detail={`p95 ${duration(attempts.p95QueueMilliseconds)} · ${attempts.capacityWaits} capacity waits`}
            label="Average queue time"
            value={duration(attempts.averageQueueMilliseconds)}
          />
          <MetricCard
            detail={`${attempts.figuresCached} cached · ${attempts.figuresFailed} failed · ${attempts.figuresSelected} selected`}
            label="Images captioned"
            value={formatCount(attempts.figuresCaptioned)}
          />
          <MetricCard
            detail={`${attempts.abandonedProviderCalls} abandoned · ${formatCount(attempts.inputTokens + attempts.outputTokens)} tokens`}
            label="Provider calls"
            value={formatCount(attempts.providerCalls)}
          />
          <MetricCard
            label="Chunks created"
            value={formatCount(attempts.chunksCreated)}
          />
          <MetricCard
            detail={`${percent(attempts.ocrPages, attempts.pages)} of parsed pages`}
            label="OCR pages"
            value={formatCount(attempts.ocrPages)}
          />
          <MetricCard
            detail={`${attempts.capacityWaits} capacity waits`}
            label="Claims"
            value={formatCount(attempts.attempts)}
          />
          <MetricCard
            detail={
              latest
                ? `${formatBytes(latest.spoolBytes)} in ${formatCount(latest.spoolFiles)} files`
                : 'No spool sample'
            }
            label="Spool free"
            value={latest ? formatBytes(latest.diskFreeBytes) : '—'}
          />
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Current workers</CardTitle>
          <CardDescription>
            Latest cgroup sample for each ingest worker container and parse
            coordinator container. A parse coordinator's child lanes share one
            row because they share one cgroup.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {environment.workers.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Worker</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Stage / claim</TableHead>
                  <TableHead className="text-right">CPU</TableHead>
                  <TableHead className="text-right">Memory</TableHead>
                  <TableHead className="text-right">PIDs</TableHead>
                  <TableHead>Sampled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {environment.workers.map((worker) => (
                  <TableRow key={worker.workerInstanceId}>
                    <TableCell>
                      <p className="font-mono text-xs">
                        {worker.workerInstanceId}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {worker.role} · {worker.hostId}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          worker.oomKillEvents > 0 || worker.stale
                            ? 'destructive'
                            : worker.state === 'busy'
                              ? 'secondary'
                              : 'outline'
                        }
                      >
                        {worker.stale ? 'stale' : worker.state}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {worker.stage || '—'}
                      {worker.jobAttemptId ? (
                        <p className="font-mono text-muted-foreground">
                          claim {worker.jobAttemptId}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {worker.cpuCores.toFixed(2)} cores
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBytes(worker.memoryBytes)}
                      {worker.memoryLimitBytes > 0 ? (
                        <p className="text-muted-foreground text-xs">
                          / {formatBytes(worker.memoryLimitBytes)}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {worker.pidsCurrent}
                      {worker.pidsLimit > 0 ? ` / ${worker.pidsLimit}` : ''}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDateTime(worker.sampledAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              description="No worker container has reported a cgroup sample."
              title="No workers"
            />
          )}
        </CardContent>
      </Card>

      <section className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Error breakdown</CardTitle>
            <CardDescription>
              Retrying, failed, and lease-expired claims in the selected range.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {environment.errors.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category / code</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {environment.errors.map((item) => (
                    <TableRow
                      key={`${item.category}:${item.code}:${item.stage}`}
                    >
                      <TableCell className="font-mono text-xs">
                        {item.category || 'unknown'} /{' '}
                        {item.code || 'unclassified'}
                      </TableCell>
                      <TableCell>{item.stage || 'unknown'}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(item.count)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                description="No failed or retrying claims in this range."
                title="No errors"
              />
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 shadow-sm">
          <CardHeader>
            <CardTitle>Recent claims</CardTitle>
            <CardDescription>
              Identifiers are operational IDs only; source names and content are
              not recorded.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {environment.recentAttempts.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Claim</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Work</TableHead>
                    <TableHead className="text-right">Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {environment.recentAttempts.map((attempt) => (
                    <TableRow key={attempt.id}>
                      <TableCell>
                        <p className="font-mono text-xs">{attempt.jobId}</p>
                        <p className="text-muted-foreground text-xs">
                          {attempt.jobType} #{attempt.attempt} ·{' '}
                          {formatDateTime(attempt.claimedAt)}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(attempt.status)}>
                          {attempt.status}
                        </Badge>
                        {attempt.errorCode ? (
                          <p className="mt-1 font-mono text-destructive text-xs">
                            {attempt.errorCode}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell>{attempt.stage}</TableCell>
                      <TableCell className="text-xs">
                        {attempt.pages} pages · {attempt.slices} slices
                        <br />
                        {attempt.figuresCaptioned} captions ·{' '}
                        {attempt.providerCalls} calls
                        {slowestStage(attempt.stageTimings) ? (
                          <>
                            <br />
                            slowest: {slowestStage(attempt.stageTimings)}
                          </>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {duration(attempt.durationMilliseconds)}
                        <br />
                        <span className="text-muted-foreground">
                          queue {duration(attempt.queueMilliseconds)}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                description="No ingest claims have been recorded."
                title="No claims"
              />
            )}
          </CardContent>
        </Card>
      </section>

      {latest &&
      (latest.swapUsedBytes > 0 || latest.parserOomKillEvents > 0) ? (
        <p className="text-destructive text-sm">
          Capacity warning: {formatBytes(latest.swapUsedBytes)} swap and{' '}
          {latest.parserOomKillEvents} parser OOM kills observed.
        </p>
      ) : null}
    </>
  );
}
