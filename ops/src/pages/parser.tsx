import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
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
import { formatBytes, formatCount, formatDateTime, percent } from '@/format';

const GIB = 1024 ** 3;

function duration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${formatCount(milliseconds)} ms`;
  }
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

const tooltipStyle = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
};

export function ParserPage() {
  const { api } = useOpsApp();
  const { data, error, isPending, refetch } = useQuery({
    queryFn: () => api.parserMetrics(24),
    queryKey: ['parser-metrics', 24],
    refetchInterval: 30_000,
  });

  const rows = useMemo(
    () =>
      (data?.samples ?? []).map((sample) => ({
        ...sample,
        hostMemoryGiB: sample.memoryUsedBytes / GIB,
        parserMemoryGiB: sample.parserMemoryBytes / GIB,
        parserPssGiB: sample.parserPssBytes / GIB,
      })),
    [data?.samples]
  );

  if (isPending) {
    return <PageLoading label="Loading parser VM metrics" />;
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }

  const latest = data.samples.at(-1);
  const attempts = data.attempts;
  return (
    <>
      <PageHeader
        actions={
          <FreshnessNote>
            Permanent raw samples; charts use one-minute buckets for the last 24
            hours.
          </FreshnessNote>
        }
        description={`Host saturation and attributable parse work. User billing remains page-based. Data as of ${formatDateTime(data.dataAsOf)}.`}
        title="Parser VM"
      />

      <section
        aria-label="Current parser capacity"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <MetricCard
          detail={
            latest
              ? `${latest.queuedJobs} queued · ${latest.hostId}`
              : 'No host sample yet'
          }
          label="Active jobs"
          tone={latest && latest.queuedJobs > 0 ? 'warning' : 'neutral'}
          value={formatCount(latest?.activeJobs ?? 0)}
        />
        <MetricCard
          detail={
            latest ? `Load ${latest.load1.toFixed(2)}` : 'No host sample yet'
          }
          label="Host CPU"
          tone={latest && latest.cpuPercent >= 90 ? 'danger' : 'neutral'}
          value={`${(latest?.cpuPercent ?? 0).toFixed(1)}%`}
        />
        <MetricCard
          detail={
            latest
              ? `${formatBytes(latest.parserPssBytes)} parser PSS`
              : 'No host sample yet'
          }
          label="Host memory"
          tone={
            latest &&
            latest.memoryTotalBytes > 0 &&
            latest.memoryUsedBytes / latest.memoryTotalBytes >= 0.9
              ? 'danger'
              : 'neutral'
          }
          value={
            latest
              ? `${formatBytes(latest.memoryUsedBytes)} / ${formatBytes(latest.memoryTotalBytes)}`
              : '—'
          }
        />
        <MetricCard
          detail={`${formatCount(attempts.ocrPages)} OCR pages · ${formatCount(attempts.attempts)} attempts`}
          label="Pages, 24h"
          value={formatCount(attempts.pages)}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card className="min-w-0 shadow-sm">
          <CardHeader>
            <CardTitle>CPU and admission</CardTitle>
            <CardDescription>
              Host CPU, active parses, and requests waiting behind the parser
              semaphores.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div
              aria-label="Parser CPU and jobs chart"
              className="h-80"
              role="img"
            >
              <ResponsiveContainer height="100%" width="100%">
                <LineChart data={rows} margin={{ left: 4, right: 12, top: 4 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="sampledAt"
                    minTickGap={36}
                    tickFormatter={timeLabel}
                  />
                  <YAxis domain={[0, 100]} unit="%" yAxisId="cpu" />
                  <YAxis
                    allowDecimals={false}
                    orientation="right"
                    yAxisId="jobs"
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={timeLabel}
                  />
                  <Legend />
                  <Line
                    dataKey="cpuPercent"
                    dot={false}
                    name="CPU %"
                    stroke="var(--chart-1)"
                    yAxisId="cpu"
                  />
                  <Line
                    dataKey="activeJobs"
                    dot={false}
                    name="Active"
                    stroke="var(--chart-2)"
                    yAxisId="jobs"
                  />
                  <Line
                    dataKey="queuedJobs"
                    dot={false}
                    name="Queued"
                    stroke="var(--chart-3)"
                    yAxisId="jobs"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 shadow-sm">
          <CardHeader>
            <CardTitle>Memory</CardTitle>
            <CardDescription>
              Host use, parser cgroup use, and proportional set size. Any swap
              is a capacity failure signal.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div aria-label="Parser memory chart" className="h-80" role="img">
              <ResponsiveContainer height="100%" width="100%">
                <LineChart data={rows} margin={{ left: 4, right: 12, top: 4 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="sampledAt"
                    minTickGap={36}
                    tickFormatter={timeLabel}
                  />
                  <YAxis
                    tickFormatter={(value: number) => `${value.toFixed(0)} GiB`}
                    width={62}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(value) =>
                      typeof value === 'number'
                        ? `${value.toFixed(2)} GiB`
                        : value
                    }
                    labelFormatter={timeLabel}
                  />
                  <Legend />
                  <Line
                    dataKey="hostMemoryGiB"
                    dot={false}
                    name="Host used"
                    stroke="var(--chart-1)"
                  />
                  <Line
                    dataKey="parserMemoryGiB"
                    dot={false}
                    name="Parser cgroup"
                    stroke="var(--chart-2)"
                  />
                  <Line
                    dataKey="parserPssGiB"
                    dot={false}
                    name="Parser PSS"
                    stroke="var(--chart-3)"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </section>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Attributed work, last 24 hours</CardTitle>
          <CardDescription>
            Dedicated child-process CPU is attributable. Shared layout-server
            CPU and host saturation stay separate in the charts above.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            detail={`${attempts.averageAttributedCpuCores.toFixed(2)} average attributed cores`}
            label="Worker CPU"
            value={duration(attempts.cpuMilliseconds)}
          />
          <MetricCard
            detail={`${duration(attempts.downloadMilliseconds)} download · ${duration(attempts.uploadMilliseconds)} upload`}
            label="Parse wall time"
            value={duration(attempts.elapsedMilliseconds)}
          />
          <MetricCard
            detail={`${formatBytes(attempts.peakWorkerPssBytes)} max observed PSS`}
            label="Max observed worker RSS"
            value={formatBytes(attempts.peakWorkerRssBytes)}
          />
          <MetricCard
            detail={`${formatBytes(attempts.ioReadBytes)} read · ${formatBytes(attempts.ioWriteBytes)} written`}
            label="Queue time"
            value={duration(attempts.queueMilliseconds)}
          />
        </CardContent>
      </Card>

      {latest && latest.swapUsedBytes > 0 ? (
        <p className="text-destructive text-sm">
          Swap is in use ({formatBytes(latest.swapUsedBytes)}). Reduce parser
          concurrency before accepting more traffic.
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">
        OCR share: {percent(attempts.ocrPages, attempts.pages)}. Network
        counters are permanent host totals; per-attempt B2 transfer durations
        are shown above.
      </p>
    </>
  );
}
