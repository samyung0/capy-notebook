import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useOpsApp } from '@/app-context';
import {
  EmptyState,
  ErrorState,
  MetricCard,
  PageHeader,
  PageLoading,
} from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  formatDateTime,
  formatShortDate,
} from '@/format';

export function UserLookupPage() {
  const { api } = useOpsApp();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const {
    data = [],
    error,
    isFetching,
    refetch,
  } = useQuery({
    enabled: query.length > 0,
    queryFn: () => api.searchUsers(query),
    queryKey: ['users', query],
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(input.trim());
  }

  return (
    <>
      <PageHeader
        description="Search by exact or partial user ID or email address."
        title="User lookup"
      />
      <Card className="shadow-sm">
        <CardContent className="p-5">
          <form
            action="/users"
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            method="get"
            onSubmit={submit}
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="user-query">User ID or email</Label>
              <Input
                autoComplete="off"
                id="user-query"
                name="q"
                onChange={(event) => setInput(event.currentTarget.value)}
                placeholder="user_… or operator@example.com"
                required
                value={input}
              />
            </div>
            <Button className="min-h-9" type="submit">
              <Search aria-hidden="true" />
              Search
            </Button>
          </form>
        </CardContent>
      </Card>

      {error ? (
        <ErrorState error={error} retry={() => void refetch()} />
      ) : query && !isFetching && data.length === 0 ? (
        <EmptyState
          description="Check the identifier or email and try again."
          title="No users found"
        />
      ) : query ? (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Results</CardTitle>
            <CardDescription>
              {isFetching ? 'Updating results…' : `${data.length} matches`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell>
                      <Link
                        className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        params={{ userId: user.userId }}
                        to="/users/$userId"
                      >
                        {user.email || user.name || user.userId}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {user.userId}
                    </TableCell>
                    <TableCell>{user.planTier}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{user.accountState}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          description="Results include account state, balances, usage, and workspace counts."
          title="Enter a user identifier"
        />
      )}
    </>
  );
}

export function UserDetailPage({ userId }: { userId: string }) {
  const { api } = useOpsApp();
  const { data, error, isPending, refetch } = useQuery({
    queryFn: () => api.user(userId),
    queryKey: ['user', userId],
  });

  const usage = useMemo(() => {
    if (!data) {
      return [];
    }
    const days = new Map<string, { day: string; credits: number }>();
    for (const point of data.usageByKind) {
      const day = point.day.slice(0, 10);
      const row = days.get(day) ?? { credits: 0, day };
      row.credits += point.creditMicros;
      days.set(day, row);
    }
    return [...days.values()].sort((left, right) =>
      left.day.localeCompare(right.day)
    );
  }, [data]);

  if (isPending) {
    return <PageLoading label="Loading user details" />;
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }

  const fileCount = data.workspaces.reduce(
    (total, workspace) => total + workspace.fileCount,
    0
  );
  const availableCredits = Math.max(
    data.credits.limitMicros -
      data.credits.usedMicros -
      data.credits.reservedMicros,
    0
  );

  return (
    <>
      <PageHeader
        actions={<Badge variant="outline">{data.accountState}</Badge>}
        description={data.userId}
        title={data.email || data.name || data.userId}
      />

      <section
        aria-label="User balances"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <MetricCard
          detail={`${formatCredits(data.credits.reservedMicros)} reserved`}
          label="Credits available"
          value={formatCredits(availableCredits)}
        />
        <MetricCard
          detail={`${formatCredits(data.credits.limitMicros)} period limit`}
          label="Credits used"
          value={formatCredits(data.credits.usedMicros)}
        />
        <MetricCard
          detail={`${formatBytes(data.storage.reservedBytes)} reserved`}
          label="Storage used"
          value={formatBytes(data.storage.usedBytes)}
        />
        <MetricCard
          detail={`${formatCount(fileCount)} files · ${data.planTier}`}
          label="Workspaces"
          value={formatCount(data.workspaces.length)}
        />
      </section>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>90-day usage</CardTitle>
          <CardDescription>
            Daily credits across all usage kinds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            aria-label="Ninety-day credit usage bar chart"
            className="h-72"
            role="img"
          >
            <ResponsiveContainer height="100%" width="100%">
              <BarChart data={usage}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  axisLine={false}
                  dataKey="day"
                  minTickGap={24}
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
                <Bar
                  dataKey="credits"
                  fill="var(--chart-1)"
                  name="Credits"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Workspaces and files</CardTitle>
          <CardDescription>
            Names are omitted to avoid exposing customer content.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace ID</TableHead>
                <TableHead className="text-right">Files</TableHead>
                <TableHead>Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.workspaces.map((workspace) => (
                <TableRow key={workspace.id}>
                  <TableCell className="font-mono text-xs">
                    {workspace.id}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(workspace.fileCount)}
                  </TableCell>
                  <TableCell>
                    {formatDateTime(workspace.lastActivityAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Recent usage events</CardTitle>
          <CardDescription>
            Operational metadata only. Prompts, responses, and event metadata
            are not shown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Kind / surface</TableHead>
                <TableHead>Provider / model</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Credits</TableHead>
                <TableHead>Trace ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recentUsage.map((event) => (
                <TableRow key={`${event.traceId}:${event.createdAt}`}>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(event.createdAt)}
                  </TableCell>
                  <TableCell>
                    {event.kind} / {event.surface}
                  </TableCell>
                  <TableCell>
                    {event.provider} / {event.modelKey} v{event.modelVersion}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(event.inputTokens + event.outputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCredits(event.creditMicros)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {event.traceId}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
