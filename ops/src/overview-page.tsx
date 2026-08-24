import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import type { Overview } from './api';
import { useOpsApp } from './app-context';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from './components/ui/chart';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table';
import {
  EmptyState,
  ErrorState,
  formatBytes,
  formatCredits,
  formatNumber,
  MetricCard,
  PageHeader,
  PageSkeleton,
  POLL_INTERVAL,
} from './ops-ui';

const chartColors = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'oklch(0.58 0.14 225)',
  'oklch(0.62 0.12 115)',
];

type UsagePoint = Overview['byKind'][number];
type ChartRow = Record<string, string | number>;

function pivotUsage(points: UsagePoint[]): {
  rows: ChartRow[];
  keys: string[];
  config: ChartConfig;
} {
  const keys = [...new Set(points.map((point) => point.key))].sort();
  const byDay = new Map<string, ChartRow>();
  for (const point of points) {
    const row = byDay.get(point.day) ?? { day: point.day };
    row[point.key] = point.creditMicros / 1_000_000;
    byDay.set(point.day, row);
  }
  const config: ChartConfig = {};
  keys.forEach((key, index) => {
    config[key] = {
      color: chartColors[index % chartColors.length],
      label: key,
    };
  });
  return {
    config,
    keys,
    rows: [...byDay.values()].sort((left, right) =>
      String(left.day).localeCompare(String(right.day))
    ),
  };
}

function StackedUsageChart({
  title,
  description,
  points,
}: {
  title: string;
  description: string;
  points: UsagePoint[];
}) {
  const { rows, keys, config } = pivotUsage(points);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            description="The daily rollup returned no rows for this period."
            title="No usage recorded"
          />
        ) : (
          <ChartContainer
            aria-label={title}
            className="h-80 w-full"
            config={config}
            role="img"
          >
            <AreaChart data={rows} margin={{ left: 8, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="day"
                minTickGap={28}
                tickFormatter={(value) =>
                  new Intl.DateTimeFormat('en-US', {
                    day: 'numeric',
                    month: 'short',
                  }).format(new Date(`${String(value)}T00:00:00Z`))
                }
                tickLine={false}
              />
              <YAxis
                axisLine={false}
                tickFormatter={(value) => formatNumber(Number(value))}
                tickLine={false}
                width={48}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => (
                      <div className="flex min-w-36 items-center justify-between gap-4">
                        <span className="text-muted-foreground">
                          {String(name)}
                        </span>
                        <span className="font-medium font-mono">
                          {formatCredits(Number(value) * 1_000_000)} credits
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              {keys.map((key) => (
                <Area
                  dataKey={key}
                  fill={`var(--color-${key})`}
                  fillOpacity={0.35}
                  key={key}
                  stackId="credits"
                  stroke={`var(--color-${key})`}
                  type="monotone"
                />
              ))}
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const { api } = useOpsApp();
  const { data, error, isError, isPending, refetch } = useQuery({
    queryFn: () => api.overview(30),
    queryKey: ['ops', 'overview', 30],
    refetchInterval: POLL_INTERVAL,
  });

  if (isPending) {
    return <PageSkeleton />;
  }
  if (isError || !data) {
    return <ErrorState error={error} onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        description="Thirty-day spend, customer concentration, storage, and queue activity."
        title="Overview"
      />
      <section
        aria-label="Current totals"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <MetricCard
          detail="Credits consumed since 00:00 UTC"
          label="Credits today"
          value={formatCredits(data.todayCredits)}
        />
        <MetricCard
          detail="Credits consumed since the month began"
          label="Credits this month"
          value={formatCredits(data.monthCredits)}
        />
        <MetricCard
          detail="Effective bytes across all customer accounts"
          label="Storage used"
          value={formatBytes(data.storageTotal)}
        />
        <MetricCard
          detail="Workspaces active during the last seven days"
          label="Active workspaces"
          value={formatNumber(data.activeWorkspaces7d)}
        />
      </section>

      <section aria-label="Usage charts" className="grid gap-6 2xl:grid-cols-2">
        <StackedUsageChart
          description="Credits per day split by metered work type."
          points={data.byKind}
          title="Usage by kind"
        />
        <StackedUsageChart
          description="Credits per day split by product surface."
          points={data.bySurface}
          title="Usage by surface"
        />
      </section>

      <section
        aria-label="Operational counters"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"
      >
        <MetricCard
          label="Signups today"
          value={formatNumber(data.signupsToday)}
        />
        <MetricCard
          label="Jobs queued"
          value={formatNumber(data.jobs.queued)}
        />
        <MetricCard
          label="Jobs running"
          value={formatNumber(data.jobs.running)}
        />
        <MetricCard
          label="Jobs failed, 24h"
          tone={data.jobs.failed24h > 0 ? 'danger' : 'success'}
          value={formatNumber(data.jobs.failed24h)}
        />
        <MetricCard
          label="Top user share"
          value={
            data.monthCredits > 0 && data.topUsers[0]
              ? `${Math.round((data.topUsers[0].creditMicros / data.monthCredits) * 100)}%`
              : '0%'
          }
        />
      </section>

      <section
        aria-label="Ranked customers"
        className="grid gap-6 2xl:grid-cols-2"
      >
        <Card>
          <CardHeader>
            <CardTitle>Top users by credits</CardTitle>
            <CardDescription>
              Current billing period, capped at 20 users.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.topUsers.length === 0 ? (
              <EmptyState
                description="No customer usage has been rolled up this month."
                title="No user spend"
              />
            ) : (
              <Table>
                <TableCaption>
                  Top users by credits this billing period.
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">User</TableHead>
                    <TableHead scope="col">Plan</TableHead>
                    <TableHead className="text-right" scope="col">
                      Credits
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topUsers.map((user) => (
                    <TableRow key={user.userId}>
                      <TableCell>
                        <Link
                          className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          params={{ userId: user.userId }}
                          to="/users/$userId"
                        >
                          {user.name || user.email || user.userId}
                        </Link>
                        <span className="block max-w-64 truncate text-muted-foreground text-xs">
                          {user.name || user.email || user.userId}
                        </span>
                      </TableCell>
                      <TableCell>{user.planTier}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatCredits(user.creditMicros)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top storage consumers</CardTitle>
            <CardDescription>
              Effective used bytes, capped at 20 users.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.topStorage.length === 0 ? (
              <EmptyState
                description="No customer storage counters were returned."
                title="No storage usage"
              />
            ) : (
              <Table>
                <TableCaption>Top users by effective storage use.</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">User</TableHead>
                    <TableHead className="text-right" scope="col">
                      Storage
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topStorage.map((user) => (
                    <TableRow key={user.userId}>
                      <TableCell>
                        <Link
                          className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          params={{ userId: user.userId }}
                          to="/users/$userId"
                        >
                          {user.email || user.userId}
                        </Link>
                        <span className="block max-w-64 truncate text-muted-foreground text-xs">
                          {user.email || user.userId}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatBytes(user.usedBytes)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
