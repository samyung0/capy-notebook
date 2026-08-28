import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query';
import type { OperatorAuditEvent, OperatorAuditPage } from '@/api';
import { useOpsApp } from '@/app-context';
import {
  ErrorState,
  FreshnessNote,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/format';

function count(metadata: Record<string, unknown>, key: string): number {
  const value = metadata[key];
  return typeof value === 'number' ? value : 0;
}

function auditSummary(event: OperatorAuditEvent): string {
  if (event.action === 'registry.saved') {
    const previous = count(event.metadata, 'previous_revision');
    const next = count(event.metadata, 'new_revision');
    const inserted = count(event.metadata, 'inserted_rows');
    const disabled = count(event.metadata, 'disabled_rows');
    const remapped = count(event.metadata, 'remapped_users');
    return `Revision ${previous} to ${next}. ${inserted} inserted, ${disabled} disabled, ${remapped} user preferences remapped.`;
  }
  if (event.action === 'reconciliation.requested') {
    const jobType = String(event.metadata.job_type ?? 'unknown');
    const runID = String(event.metadata.run_id ?? event.targetId);
    return `${jobType} reconciliation, run ${runID}.`;
  }
  return JSON.stringify(event.metadata);
}

function actionLabel(action: string): string {
  switch (action) {
    case 'registry.saved':
      return 'Registry saved';
    case 'reconciliation.requested':
      return 'Reconciliation requested';
    default:
      return action;
  }
}

export function AuditPage() {
  const { api } = useOpsApp();
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
    refetch,
  } = useInfiniteQuery<
    OperatorAuditPage,
    Error,
    InfiniteData<OperatorAuditPage>,
    string[],
    number | undefined
  >({
    getNextPageParam: (lastPage) => lastPage.nextBeforeId,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.audit(pageParam),
    queryKey: ['operator-audit'],
  });

  if (isPending) {
    return <PageLoading label="Loading operator audit history" />;
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }

  const events = data.pages.flatMap((page) => page.events);

  return (
    <>
      <PageHeader
        actions={
          <FreshnessNote>
            Database history, refreshed every 30 seconds.
          </FreshnessNote>
        }
        description="Accepted operator mutations, recorded in the same transaction as the action. Job execution details remain on the reconciliation page."
        title="Operator audit"
      />

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Action history</CardTitle>
          <CardDescription>
            Registry saves and manual reconciliation requests, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="py-10 text-center text-muted-foreground text-sm">
              No operator mutations have been recorded.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Operator</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead>Trace</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap align-top">
                      {formatDateTime(event.occurredAt)}
                    </TableCell>
                    <TableCell className="align-top">
                      <span className="block max-w-48 truncate font-mono text-xs">
                        {event.actorUserId}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {event.actorRole}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top font-medium">
                      {actionLabel(event.action)}
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge variant="outline">{event.outcome}</Badge>
                    </TableCell>
                    <TableCell className="min-w-72 align-top text-sm">
                      {auditSummary(event)}
                    </TableCell>
                    <TableCell className="align-top">
                      {event.traceId ? (
                        <code
                          className="font-mono text-xs"
                          title={event.traceId}
                        >
                          {event.traceId.slice(0, 12)}
                        </code>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          Unavailable
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {hasNextPage ? (
            <div className="mt-5 flex justify-center border-t pt-5">
              <Button
                disabled={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
                variant="outline"
              >
                {isFetchingNextPage
                  ? 'Loading older events'
                  : 'Load older events'}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
