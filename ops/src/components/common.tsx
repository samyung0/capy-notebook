import { AlertTriangle, Inbox, LoaderCircle, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { OpsApiError } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground text-sm">
          {description}
        </p>
      </div>
      {actions}
    </header>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: 'neutral' | 'warning' | 'danger' | 'success';
}) {
  return (
    <Card
      className={cn(
        'shadow-sm',
        tone === 'warning' && 'border-amber-300 bg-amber-50/40',
        tone === 'danger' && 'border-red-300 bg-red-50/40',
        tone === 'success' && 'border-emerald-300 bg-emerald-50/40'
      )}
    >
      <CardContent className="p-5">
        <p className="font-medium text-muted-foreground text-sm">{label}</p>
        <p className="mt-2 font-semibold text-2xl tabular-nums">{value}</p>
        {detail ? (
          <p className="mt-1 text-muted-foreground text-xs">{detail}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function PageLoading({ label = 'Loading data' }: { label?: string }) {
  return (
    <div aria-label={label} className="space-y-4" role="status">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

export function InlineLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted-foreground text-sm">
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      {label}
    </span>
  );
}

function errorText(error: unknown): string {
  if (error instanceof OpsApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'The request failed.';
}

export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <Card className="border-red-200 bg-red-50/50 shadow-sm">
      <CardContent className="flex flex-col items-start gap-3 p-5">
        <div className="flex items-center gap-2 font-medium text-red-900">
          <AlertTriangle aria-hidden="true" className="size-4" />
          Could not load this data
        </div>
        <p className="text-red-800 text-sm">{errorText(error)}</p>
        {retry ? (
          <Button onClick={retry} size="sm" type="button" variant="outline">
            <RotateCcw aria-hidden="true" />
            Try again
          </Button>
        ) : null}
      </CardContent>
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
    <div className="grid min-h-48 place-items-center rounded-lg border border-dashed p-8 text-center">
      <div>
        <Inbox
          aria-hidden="true"
          className="mx-auto size-6 text-muted-foreground"
        />
        <p className="mt-3 font-medium">{title}</p>
        <p className="mt-1 text-muted-foreground text-sm">{description}</p>
      </div>
    </div>
  );
}
