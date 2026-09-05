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
  FreshnessNote,
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
        actions={
          <FreshnessNote>
            Search results refresh every 30 seconds.
          </FreshnessNote>
        }
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
        actions={
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <Badge variant="outline">{data.accountState}</Badge>
            <FreshnessNote>
              Refreshes every 30 seconds. Snapshot at{' '}
              {formatDateTime(data.dataAsOf)}. Provider usage appears after its
              response settles.
            </FreshnessNote>
          </div>
        }
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

      {data.sessionRevocationPending ? (
        <Card className="border-destructive/40 shadow-sm">
          <CardHeader>
            <CardTitle>Clerk session revocation pending</CardTitle>
            <CardDescription>
              Support restoration is blocked until a complete session sweep
              succeeds.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>{formatCount(data.sessionRevocationAttempts)} failed attempts</p>
            {data.sessionRevocationDueAt ? (
              <p>Next retry: {formatDateTime(data.sessionRevocationDueAt)}</p>
            ) : null}
            {data.sessionRevocationError ? (
              <p className="font-mono text-muted-foreground text-xs">
                {data.sessionRevocationError}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Current-month usage</CardTitle>
          <CardDescription>
            Daily credits across all usage kinds, bucketed in UTC.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            aria-label="Current-month credit usage bar chart"
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
            Workspace metadata is shown. Material bodies, file contents,
            prompts, and responses are not shown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Workspace ID</TableHead>
                <TableHead className="text-right">Files</TableHead>
                <TableHead>Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.workspaces.map((workspace) => (
                <TableRow key={workspace.id}>
                  <TableCell>{workspace.name}</TableCell>
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
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Kind / surface</TableHead>
                  <TableHead>Catalog / observed model</TableHead>
                  <TableHead>Thinking</TableHead>
                  <TableHead className="text-right">
                    Input / cached / output / reasoning
                  </TableHead>
                  <TableHead className="text-right">
                    Pages / OCR / CPU ms / elapsed ms
                  </TableHead>
                  <TableHead className="text-right">
                    System / tools / conversation
                  </TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                  <TableHead>Call / trace</TableHead>
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
                      {event.purpose ? ` / ${event.purpose}` : ''}
                    </TableCell>
                    <TableCell>
                      <span className="block">
                        {event.catalogProviderSlug
                          ? `${event.catalogProviderSlug} / ${event.catalogModelSlug} v${event.modelVersion}`
                          : event.provider || 'No provider'}
                      </span>
                      {event.catalogProviderSlug && event.provider ? (
                        <span className="block text-muted-foreground text-xs">
                          observed: {event.provider}
                          {event.model ? ` / ${event.model}` : ''}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>{event.thinking || '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(event.inputTokens)} /{' '}
                      {formatCount(event.cachedReadTokens)} /{' '}
                      {formatCount(event.outputTokens)} /{' '}
                      {formatCount(event.reasoningTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(event.parsePages)} /{' '}
                      {formatCount(event.parseOcrPages)} /{' '}
                      {formatCount(event.parseCpuMilliseconds)} /{' '}
                      {formatCount(event.parseElapsedMilliseconds)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {event.contextTotalTokens > 0 ? (
                        <span
                          title={`${event.contextCountingMethod} v${event.contextCountingVersion}; ${formatCount(event.contextTotalTokens)} estimated of ${formatCount(event.contextWindowTokens)} window tokens`}
                        >
                          <span className="block">
                            {formatCount(event.contextSystemTokens)} /{' '}
                            {formatCount(event.contextToolTokens)} /{' '}
                            {formatCount(event.contextConversationTokens)}
                          </span>
                          <span className="block text-muted-foreground text-xs">
                            Δ actual−estimated{' '}
                            {formatCount(
                              event.inputTokens - event.contextTotalTokens
                            )}
                          </span>
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCredits(event.creditMicros)}
                      {event.paidBy ? ` · ${event.paidBy}` : ''}
                    </TableCell>
                    <TableCell className="max-w-64 font-mono text-xs">
                      <span
                        className="block truncate"
                        title={event.providerCallId}
                      >
                        {event.providerCallId || 'No call'}
                        {event.providerCallStatus
                          ? ` · ${event.providerCallStatus}`
                          : ''}
                      </span>
                      <span
                        className="block truncate text-muted-foreground"
                        title={event.traceId}
                      >
                        {event.traceId || 'No trace'}
                      </span>
                      {event.cacheAnomaly ? (
                        <span className="block text-amber-700">
                          {event.cacheAnomaly}
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
