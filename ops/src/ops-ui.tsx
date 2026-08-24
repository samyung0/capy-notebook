import { AlertCircle, Inbox, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { OpsApiError } from './api';
import { Button } from './components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './components/ui/card';
import { Skeleton } from './components/ui/skeleton';
import { cn } from './lib/utils';

export const POLL_INTERVAL = 30_000;

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} | Evo Notes Ops`;
  }, [title]);
}

export function formatCredits(micros: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(micros / 1_000_000);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return 'Never';
  }
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground text-sm">
          {description}
        </p>
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </header>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'default' | 'danger' | 'warning' | 'success';
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={cn(
            'text-2xl tabular-nums',
            tone === 'danger' && 'text-destructive',
            tone === 'warning' && 'text-amber-700',
            tone === 'success' && 'text-emerald-700'
          )}
        >
          {value}
        </CardTitle>
      </CardHeader>
      {detail ? (
        <CardContent className="text-muted-foreground text-xs">
          {detail}
        </CardContent>
      ) : null}
    </Card>
  );
}

export function PageSkeleton() {
  return (
    <div aria-label="Loading page" className="space-y-6" role="status">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <Skeleton className="h-28" key={item} />
        ))}
      </div>
      <Skeleton className="h-80 w-full" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

function errorCopy(error: unknown): { title: string; message: string } {
  if (error instanceof OpsApiError && error.status === 401) {
    return {
      message:
        'Your Clerk session expired or Cloudflare Access rejected the request. Re-enter through Access and sign in again.',
      title: 'Authentication required',
    };
  }
  if (error instanceof OpsApiError && error.status === 403) {
    return {
      message:
        'This Clerk account is signed in but is not listed as an operator.',
      title: 'Operator access denied',
    };
  }
  return {
    message:
      error instanceof Error ? error.message : 'An unknown error occurred.',
    title: 'The ops API could not load this page',
  };
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const copy = errorCopy(error);
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <div className="flex items-center gap-2">
          <AlertCircle aria-hidden="true" className="size-5 text-destructive" />
          <CardTitle>{copy.title}</CardTitle>
        </div>
        <CardDescription>{copy.message}</CardDescription>
      </CardHeader>
      {onRetry ? (
        <CardContent>
          <Button onClick={onRetry} type="button" variant="outline">
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        </CardContent>
      ) : null}
    </Card>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
      <Inbox aria-hidden="true" className="mb-3 size-6 text-muted-foreground" />
      <h2 className="font-medium text-base">{title}</h2>
      <p className="mt-1 max-w-md text-muted-foreground text-sm">
        {description}
      </p>
    </div>
  );
}
