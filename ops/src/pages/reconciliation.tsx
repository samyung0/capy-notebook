import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { hasPermission } from '@/api';
import { useOpsApp } from '@/app-context';
import {
  ErrorState,
  FreshnessNote,
  PageHeader,
  PageLoading,
} from '@/components/common';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { formatCount, formatDateTime } from '@/format';

export function ReconciliationPage() {
  const { api, session } = useOpsApp();
  const queryClient = useQueryClient();
  const [selectedJob, setSelectedJob] = useState<'storage' | 'stripe' | null>(
    null
  );
  const { data, error, isPending, refetch } = useQuery({
    queryFn: api.reconciliation,
    queryKey: ['reconciliation'],
  });
  const {
    mutate: requestReconciliation,
    isPending: isRequesting,
    error: requestError,
  } = useMutation({
    mutationFn: api.requestReconciliation,
    onSuccess: () => {
      setSelectedJob(null);
      return queryClient.invalidateQueries({
        queryKey: ['reconciliation'],
      });
    },
  });

  if (isPending) {
    return <PageLoading label="Loading reconciliation history" />;
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }

  return (
    <>
      <PageHeader
        actions={
          <FreshnessNote>
            Job output is periodic, not live. This database view refreshes every
            30 seconds.
          </FreshnessNote>
        }
        description={`Scheduled and operator-requested storage and Stripe checks. Data as of ${formatDateTime(data.dataAsOf)}.`}
        title="Reconciliation"
      />

      {hasPermission(session, 'execute_reconciliation_job') ? (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={isRequesting}
            onClick={() => setSelectedJob('storage')}
            type="button"
            variant="outline"
          >
            Run storage reconciliation
          </Button>
          <Button
            disabled={isRequesting}
            onClick={() => setSelectedJob('stripe')}
            type="button"
            variant="outline"
          >
            Run Stripe reconciliation
          </Button>
        </div>
      ) : null}

      {requestError ? (
        <p className="text-red-700 text-sm" role="alert">
          {requestError instanceof Error
            ? requestError.message
            : 'Could not request reconciliation.'}
        </p>
      ) : null}

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Job history</CardTitle>
          <CardDescription>
            Scheduled and operator-requested runs. Latest 20.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No reconciliation runs.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Requested</TableHead>
                  <TableHead>Job</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Scanned</TableHead>
                  <TableHead className="text-right">Repaired</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.runs.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(row.requestedAt)}
                    </TableCell>
                    <TableCell>{row.jobType}</TableCell>
                    <TableCell>
                      {row.trigger}
                      {row.requestedByName ? ` · ${row.requestedByName}` : ''}
                    </TableCell>
                    <TableCell>
                      {row.status}
                      {row.error ? ` · ${row.error}` : ''}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(row.scannedCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(row.repairedCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(row.errorCount)}
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
          <CardTitle>Results inbox</CardTitle>
          <CardDescription>
            Drift repairs and per-item failures worth operator attention. Latest
            50.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.reports.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No reconciliation events.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Run</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Evidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.reports.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.runId}
                    </TableCell>
                    <TableCell>{row.eventType}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.subjectType}:{row.subjectId}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.actorUserId || '—'}
                    </TableCell>
                    <TableCell>
                      {Object.keys(row.metadata).length === 0 ? (
                        '—'
                      ) : (
                        <details>
                          <summary className="cursor-pointer text-sm">
                            View
                          </summary>
                          <pre className="mt-2 max-w-96 overflow-auto rounded bg-muted p-2 text-xs">
                            {JSON.stringify(row.metadata, null, 2)}
                          </pre>
                        </details>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setSelectedJob(null);
          }
        }}
        open={selectedJob !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Run {selectedJob} reconciliation?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The request will be queued and recorded with your operator
              identity. Only drift and item failures appear in the inbox.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isRequesting}
              onClick={() => {
                if (selectedJob) {
                  requestReconciliation(selectedJob);
                }
              }}
            >
              Queue run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
