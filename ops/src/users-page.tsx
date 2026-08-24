import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useOpsApp } from './app-context';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './components/ui/card';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
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
  formatDateTime,
  formatNumber,
  MetricCard,
  PageHeader,
  PageSkeleton,
  POLL_INTERVAL,
} from './ops-ui';

export function UserSearchPage() {
  const { api } = useOpsApp();
  const { q } = useSearch({ from: '/users' });
  const navigate = useNavigate({ from: '/users' });
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);

  const {
    data = [],
    error,
    isError,
    isFetching,
  } = useQuery({
    enabled: q.trim().length > 0,
    queryFn: () => api.searchUsers(q.trim()),
    queryKey: ['ops', 'users', q],
    refetchInterval: POLL_INTERVAL,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        description="Look up a customer by email or Clerk user ID. Results never include note or chat content."
        title="User support"
      />
      <form
        className="flex max-w-2xl flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ search: { q: input.trim() } });
        }}
      >
        <div className="flex-1 space-y-2">
          <Label htmlFor="user-search">Email or user ID</Label>
          <Input
            autoComplete="off"
            id="user-search"
            onChange={(event) => setInput(event.currentTarget.value)}
            placeholder="user@example.com or user_..."
            value={input}
          />
        </div>
        <Button disabled={isFetching} type="submit">
          <Search aria-hidden="true" />
          Search
        </Button>
      </form>

      {isError ? (
        <ErrorState error={error} />
      ) : q.trim().length === 0 ? (
        <EmptyState
          description="Enter an email address or Clerk user ID to begin."
          title="Search for a user"
        />
      ) : isFetching && data.length === 0 ? (
        <PageSkeleton />
      ) : data.length === 0 ? (
        <EmptyState
          description={`No operator-visible user matched "${q}".`}
          title="No users found"
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Search results</CardTitle>
            <CardDescription>Up to 20 matching users.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableCaption>User search results for {q}.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">User</TableHead>
                  <TableHead scope="col">Plan</TableHead>
                  <TableHead scope="col">Account state</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell>
                      <Link
                        className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        params={{ userId: user.userId }}
                        to="/users/$userId"
                      >
                        {user.name || user.email || user.userId}
                      </Link>
                      <span className="block text-muted-foreground text-xs">
                        {user.email || user.userId}
                      </span>
                    </TableCell>
                    <TableCell>{user.planTier}</TableCell>
                    <TableCell>{user.accountState ?? 'Unknown'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function UserDetailPage() {
  const { api } = useOpsApp();
  const { userId } = useParams({ from: '/users/$userId' });
  const { data, error, isError, isPending, refetch } = useQuery({
    queryFn: () => api.user(userId),
    queryKey: ['ops', 'user', userId],
    refetchInterval: POLL_INTERVAL,
  });

  if (isPending) {
    return <PageSkeleton />;
  }
  if (isError || !data) {
    return <ErrorState error={error} onRetry={() => refetch()} />;
  }

  const creditRemaining = Math.max(
    0,
    data.credits.limitMicros -
      data.credits.usedMicros -
      data.credits.reservedMicros
  );
  const storageRemaining = Math.max(
    0,
    data.storage.limitBytes -
      data.storage.usedBytes -
      data.storage.reservedBytes
  );

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button asChild variant="outline">
            <Link search={{ q: data.email || data.userId }} to="/users">
              Back to search
            </Link>
          </Button>
        }
        description={`${data.email || 'No email'} · ${data.userId}`}
        title={data.name || 'User detail'}
      />

      <section
        aria-label="Account summary"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <MetricCard
          detail={`Period started ${data.credits.periodStart}`}
          label="Plan"
          value={data.planTier}
        />
        <MetricCard
          label="Account state"
          tone={data.accountState === 'active' ? 'success' : 'warning'}
          value={data.accountState}
        />
        <MetricCard
          detail={`${formatCredits(data.credits.usedMicros)} used, ${formatCredits(data.credits.reservedMicros)} reserved`}
          label="Credits remaining"
          value={formatCredits(creditRemaining)}
        />
        <MetricCard
          detail={`${formatBytes(data.storage.usedBytes)} used, ${formatBytes(data.storage.reservedBytes)} reserved`}
          label="Storage remaining"
          value={formatBytes(storageRemaining)}
        />
      </section>

      <section
        aria-label="User activity"
        className="grid gap-6 2xl:grid-cols-2"
      >
        <Card>
          <CardHeader>
            <CardTitle>Usage by kind</CardTitle>
            <CardDescription>
              Daily usage returned by the rollup.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.usageByKind.length === 0 ? (
              <EmptyState
                description="No daily usage rows were returned for this user."
                title="No usage recorded"
              />
            ) : (
              <Table>
                <TableCaption>Daily credit usage by kind.</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Day</TableHead>
                    <TableHead scope="col">Kind</TableHead>
                    <TableHead className="text-right" scope="col">
                      Credits
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.usageByKind.map((point) => (
                    <TableRow key={`${point.day}-${point.key}`}>
                      <TableCell>{point.day}</TableCell>
                      <TableCell>{point.key}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCredits(point.creditMicros)}
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
            <CardTitle>Workspaces</CardTitle>
            <CardDescription>
              Names, file counts, and last activity only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.workspaces.length === 0 ? (
              <EmptyState
                description="This user has no operator-visible workspaces."
                title="No workspaces"
              />
            ) : (
              <Table>
                <TableCaption>Workspaces owned by this user.</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Workspace</TableHead>
                    <TableHead className="text-right" scope="col">
                      Files
                    </TableHead>
                    <TableHead scope="col">Last activity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.workspaces.map((workspace) => (
                    <TableRow key={workspace.id}>
                      <TableCell className="font-medium">
                        {workspace.name || 'Untitled workspace'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(workspace.fileCount)}
                      </TableCell>
                      <TableCell>
                        {formatDateTime(workspace.lastActivityAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Recent usage events</CardTitle>
          <CardDescription>
            The latest 50 ledger events. Copy a trace ID into logs or Sentry.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.recentUsage.length === 0 ? (
            <EmptyState
              description="No ledger events were returned for this user."
              title="No usage events"
            />
          ) : (
            <Table>
              <TableCaption>Latest 50 usage events for this user.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Time</TableHead>
                  <TableHead scope="col">Trace ID</TableHead>
                  <TableHead scope="col">Kind / surface</TableHead>
                  <TableHead scope="col">Provider / model</TableHead>
                  <TableHead className="text-right" scope="col">
                    Tokens / units
                  </TableHead>
                  <TableHead className="text-right" scope="col">
                    Credits
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentUsage.map((event) => (
                  <TableRow
                    key={`${event.createdAt}-${event.traceId}-${event.modelKey}`}
                  >
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(event.createdAt)}
                    </TableCell>
                    <TableCell>
                      <code className="select-all text-xs">
                        {event.traceId || 'None'}
                      </code>
                    </TableCell>
                    <TableCell>
                      {event.kind}
                      <span className="block text-muted-foreground text-xs">
                        {event.surface}
                      </span>
                    </TableCell>
                    <TableCell>
                      {event.provider}
                      <span className="block text-muted-foreground text-xs">
                        {event.modelKey} v{event.modelVersion} · {event.model}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(event.inputTokens + event.outputTokens)}
                      <span className="block text-muted-foreground text-xs">
                        {formatNumber(event.units)} {event.unit}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCredits(event.creditMicros)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Badge variant="outline">
        Customer content is intentionally unavailable
      </Badge>
    </div>
  );
}
