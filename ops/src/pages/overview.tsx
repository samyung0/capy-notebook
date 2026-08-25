import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Overview } from '@/api';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  formatBytes,
  formatCount,
  formatCredits,
  formatShortDate,
} from '@/format';

const chartColors = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];

type UsagePoint = Overview['byKind'][number];
type ChartRow = { day: string; [key: string]: string | number };

function pivotUsage(points: UsagePoint[]): {
  rows: ChartRow[];
  groups: string[];
} {
  const days = new Map<string, ChartRow>();
  const groups = [...new Set(points.map((point) => point.key))].sort();
  for (const point of points) {
    const day = point.day.slice(0, 10);
    const row = days.get(day) ?? { day };
    row[point.key] = point.creditMicros;
    days.set(day, row);
  }
  return {
    groups,
    rows: [...days.values()].sort((left, right) =>
      String(left.day).localeCompare(String(right.day))
    ),
  };
}

function UsageChart({
  title,
  description,
  points,
}: {
  title: string;
  description: string;
  points: UsagePoint[];
}) {
  const { rows, groups } = useMemo(() => pivotUsage(points), [points]);
  return (
    <Card className="min-w-0 shadow-sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div
          aria-label={`${title} line chart`}
          className="h-72 min-w-0"
          role="img"
        >
          <ResponsiveContainer height="100%" width="100%">
            <LineChart data={rows} margin={{ left: 4, right: 12, top: 4 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis
                axisLine={false}
                dataKey="day"
                minTickGap={28}
                tickFormatter={formatShortDate}
                tickLine={false}
              />
              <YAxis
                axisLine={false}
                tickFormatter={(value: number) => formatCredits(value)}
                tickLine={false}
                width={68}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--popover)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                }}
                formatter={(value) =>
                  typeof value === 'number' ? formatCredits(value) : value
                }
                labelFormatter={(value) => formatShortDate(String(value))}
              />
              {groups.map((group, index) => (
                <Line
                  dataKey={group}
                  dot={false}
                  key={group}
                  name={group}
                  stroke={chartColors[index % chartColors.length]}
                  strokeWidth={2}
                  type="monotone"
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
          {groups.map((group, index) => (
            <span
              className="inline-flex items-center gap-2 text-xs"
              key={group}
            >
              <span
                aria-hidden="true"
                className="size-2 rounded-full"
                style={{
                  backgroundColor: chartColors[index % chartColors.length],
                }}
              />
              {group}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const { api } = useOpsApp();
  const { data, error, isPending, refetch } = useQuery({
    queryFn: api.overview,
    queryKey: ['overview'],
    refetchInterval: 30_000,
  });

  if (isPending) {
    return <PageLoading label="Loading overview" />;
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }

  return (
    <>
      <PageHeader
        description="Thirty-day usage, storage, growth, and queue activity. Refreshes every 30 seconds."
        title="Overview"
      />

      <section
        aria-label="Credit and storage totals"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <MetricCard
          label="Credits today"
          value={formatCredits(data.todayCredits)}
        />
        <MetricCard
          label="Credits this month"
          value={formatCredits(data.monthCredits)}
        />
        <MetricCard label="Storage" value={formatBytes(data.storageTotal)} />
        <MetricCard
          label="Signups today"
          value={formatCount(data.signupsToday)}
        />
      </section>

      <section className="grid min-w-0 gap-4 xl:grid-cols-2">
        <UsageChart
          description="Credits grouped by billable event kind."
          points={data.byKind}
          title="Credits by kind"
        />
        <UsageChart
          description="Credits grouped by product surface."
          points={data.bySurface}
          title="Credits by surface"
        />
      </section>

      <section
        aria-label="Workspace and job counters"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <MetricCard
          detail="Last 7 days"
          label="Active workspaces"
          value={formatCount(data.activeWorkspaces7d)}
        />
        <MetricCard
          label="Pending jobs"
          tone={data.jobs.queued > 0 ? 'warning' : 'neutral'}
          value={formatCount(data.jobs.queued)}
        />
        <MetricCard
          label="Running jobs"
          value={formatCount(data.jobs.running)}
        />
        <MetricCard
          label="Failed jobs"
          tone={data.jobs.failed24h > 0 ? 'danger' : 'success'}
          value={formatCount(data.jobs.failed24h)}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card className="min-w-0 shadow-sm">
          <CardHeader>
            <CardTitle>Top credit users</CardTitle>
            <CardDescription>
              Highest spend in the current period.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topUsers.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell>
                      <Link
                        className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        params={{ userId: user.userId }}
                        to="/users/$userId"
                      >
                        {user.email || user.userId}
                      </Link>
                    </TableCell>
                    <TableCell>{user.planTier}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCredits(user.creditMicros)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="min-w-0 shadow-sm">
          <CardHeader>
            <CardTitle>Top storage users</CardTitle>
            <CardDescription>Highest current storage usage.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Used</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topStorage.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell>
                      <Link
                        className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        params={{ userId: user.userId }}
                        to="/users/$userId"
                      >
                        {user.email || user.userId}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBytes(user.usedBytes)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </>
  );
}
