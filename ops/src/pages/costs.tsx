import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { CostGroup, CostRow } from '@/api';
import { useOpsApp } from '@/app-context';
import {
  ErrorState,
  FreshnessNote,
  MetricCard,
  PageHeader,
  PageLoading,
} from '@/components/common';
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
  formatCount,
  formatCredits,
  formatDateTime,
  formatShortDate,
} from '@/format';

const groupOptions: { value: CostGroup; label: string }[] = [
  { label: 'Period', value: 'day' },
  { label: 'User', value: 'user' },
  { label: 'Kind', value: 'kind' },
  { label: 'Surface', value: 'surface' },
  { label: 'Catalog provider', value: 'provider' },
  { label: 'Catalog model version', value: 'model' },
  { label: 'Thinking', value: 'thinking' },
];

type Filters = {
  from: string;
  to: string;
  group: CostGroup;
  preset: 'month' | 'quarter' | 'year' | 'custom';
};

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function presetRange(
  preset: Exclude<Filters['preset'], 'custom'>
): Pick<Filters, 'from' | 'to'> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const startMonth =
    preset === 'month'
      ? month
      : preset === 'quarter'
        ? Math.floor(month / 3) * 3
        : 0;
  return {
    from: utcDay(new Date(Date.UTC(year, startMonth, 1))),
    to: utcDay(now),
  };
}

export function bucketFor(filters: Filters): 'day' | 'month' {
  const rangeDays =
    (Date.parse(filters.to) - Date.parse(filters.from)) / 86_400_000;
  return filters.preset === 'year' || rangeDays > 92 ? 'month' : 'day';
}

function formatUtilization(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function groupValue(row: CostRow, group: CostGroup): string {
  return group === 'day' ? formatShortDate(row.key) : row.key;
}

export function CostsPage() {
  const { api } = useOpsApp();
  const month = presetRange('month');
  const [draft, setDraft] = useState<Filters>({
    ...month,
    group: 'day',
    preset: 'month',
  });
  const [filters, setFilters] = useState(draft);
  const [validation, setValidation] = useState('');
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryFn: () =>
      api.costs(filters.from, filters.to, filters.group, bucketFor(filters)),
    queryKey: [
      'costs',
      filters.from,
      filters.to,
      filters.group,
      bucketFor(filters),
    ],
  });

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.from > draft.to) {
      setValidation('The start date must be on or before the end date.');
      return;
    }
    setValidation('');
    setFilters(draft);
  }

  const rows = data?.rows ?? [];
  const totals = rows.reduce(
    (total, row) => ({
      cachedReadTokens: total.cachedReadTokens + row.cachedReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + row.cacheWriteTokens,
      creditMicros: total.creditMicros + row.creditMicros,
      events: total.events + row.events,
      inputTokens: total.inputTokens + row.inputTokens,
      outputTokens: total.outputTokens + row.outputTokens,
      parseCpuMilliseconds:
        total.parseCpuMilliseconds + row.parseCpuMilliseconds,
      parseElapsedMilliseconds:
        total.parseElapsedMilliseconds + row.parseElapsedMilliseconds,
      parseOcrPages: total.parseOcrPages + row.parseOcrPages,
      parsePages: total.parsePages + row.parsePages,
      reasoningTokens: total.reasoningTokens + row.reasoningTokens,
    }),
    {
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      creditMicros: 0,
      events: 0,
      inputTokens: 0,
      outputTokens: 0,
      parseCpuMilliseconds: 0,
      parseElapsedMilliseconds: 0,
      parseOcrPages: 0,
      parsePages: 0,
      reasoningTokens: 0,
    }
  );

  return (
    <>
      <PageHeader
        actions={
          <FreshnessNote>
            Database report, refreshed every 30 seconds. Provider usage appears
            after each response settles; Ops does not poll providers.
          </FreshnessNote>
        }
        description="Credits are Evo Notes internal credits, not USD or provider invoice costs. All period boundaries use UTC."
        title="Usage explorer"
      />

      <Card className="shadow-sm">
        <CardContent className="p-5">
          <form action="/costs" method="get" onSubmit={apply}>
            <fieldset>
              <legend className="font-medium text-sm">Period</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {(['month', 'quarter', 'year', 'custom'] as const).map(
                  (preset) => (
                    <label
                      className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm hover:bg-accent"
                      key={preset}
                    >
                      <input
                        checked={draft.preset === preset}
                        className="size-4 accent-primary"
                        name="preset"
                        onChange={() => {
                          if (preset === 'custom') {
                            setDraft((current) => ({
                              ...current,
                              preset,
                            }));
                            return;
                          }
                          setDraft((current) => ({
                            ...current,
                            ...presetRange(preset),
                            preset,
                          }));
                        }}
                        type="radio"
                        value={preset}
                      />
                      {preset === 'month'
                        ? 'Current month'
                        : preset === 'quarter'
                          ? 'Current quarter'
                          : preset === 'year'
                            ? 'Current year'
                            : 'Custom'}
                    </label>
                  )
                )}
              </div>
            </fieldset>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="cost-from">From</Label>
                <Input
                  id="cost-from"
                  name="from"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      from: event.currentTarget.value,
                      preset: 'custom',
                    }))
                  }
                  required
                  type="date"
                  value={draft.from}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cost-to">To</Label>
                <Input
                  id="cost-to"
                  name="to"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      preset: 'custom',
                      to: event.currentTarget.value,
                    }))
                  }
                  required
                  type="date"
                  value={draft.to}
                />
              </div>
            </div>
            <fieldset className="mt-5">
              <legend className="font-medium text-sm">Group results by</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {groupOptions.map((option) => (
                  <label
                    className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm hover:bg-accent"
                    key={option.value}
                  >
                    <input
                      checked={draft.group === option.value}
                      className="size-4 accent-primary"
                      name="group"
                      onChange={() =>
                        setDraft((current) => ({
                          ...current,
                          group: option.value,
                        }))
                      }
                      type="radio"
                      value={option.value}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button type="submit">Run report</Button>
              {isFetching && !isPending ? (
                <span className="text-muted-foreground text-sm">
                  Updating report…
                </span>
              ) : null}
              <p aria-live="polite" className="text-destructive text-sm">
                {validation}
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      {isPending ? (
        <PageLoading label="Loading usage report" />
      ) : error ? (
        <ErrorState error={error} retry={() => void refetch()} />
      ) : (
        <>
          <section
            aria-label="Usage report totals"
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6"
          >
            <MetricCard
              label="Credits"
              value={formatCredits(totals.creditMicros)}
            />
            <MetricCard label="Events" value={formatCount(totals.events)} />
            <MetricCard
              label="Input tokens"
              value={formatCount(totals.inputTokens)}
            />
            <MetricCard
              label="Output tokens"
              value={formatCount(totals.outputTokens)}
            />
            <MetricCard
              label="Parsed pages"
              value={formatCount(totals.parsePages)}
            />
            <MetricCard
              label="OCR pages"
              value={formatCount(totals.parseOcrPages)}
            />
          </section>

          <section
            aria-label="Provider token details"
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"
          >
            <MetricCard
              label="Cached-read tokens"
              value={formatCount(totals.cachedReadTokens)}
            />
            <MetricCard
              label="Cache-write tokens"
              value={formatCount(totals.cacheWriteTokens)}
            />
            <MetricCard
              label="Reasoning tokens"
              value={formatCount(totals.reasoningTokens)}
            />
            <MetricCard
              detail="Dedicated Marker child process"
              label="Parse CPU milliseconds"
              value={formatCount(totals.parseCpuMilliseconds)}
            />
            <MetricCard
              detail="In-container parse wall time"
              label="Parse elapsed milliseconds"
              value={formatCount(totals.parseElapsedMilliseconds)}
            />
          </section>

          {data ? (
            <>
              <section
                aria-label="Context window utilization"
                className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"
              >
                <MetricCard
                  detail="All measured LLM attempts, including abandoned attempts"
                  label="Context-measured calls"
                  value={formatCount(data.contextSummary.calls)}
                />
                <MetricCard
                  label="P50 context window"
                  value={formatUtilization(
                    data.contextSummary.p50WindowUtilization
                  )}
                />
                <MetricCard
                  label="P95 context window"
                  value={formatUtilization(
                    data.contextSummary.p95WindowUtilization
                  )}
                />
                <MetricCard
                  label="Maximum context window"
                  value={formatUtilization(
                    data.contextSummary.maxWindowUtilization
                  )}
                />
                <MetricCard
                  detail={`${formatCount(data.contextSummary.callsAtLeast90Percent)} at ≥90% · ${formatCount(data.contextSummary.callsAtLeast95Percent)} at ≥95%`}
                  label="Calls at ≥80%"
                  value={formatCount(data.contextSummary.callsAtLeast80Percent)}
                />
              </section>

              <section
                aria-label="Context composition totals"
                className="grid gap-4 sm:grid-cols-3"
              >
                <MetricCard
                  label="System prompt tokens"
                  value={formatCount(data.contextSummary.systemTokens)}
                />
                <MetricCard
                  label="Tool definition tokens"
                  value={formatCount(data.contextSummary.toolTokens)}
                />
                <MetricCard
                  label="Conversation tokens"
                  value={formatCount(data.contextSummary.conversationTokens)}
                />
              </section>
            </>
          ) : null}

          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Usage rows</CardTitle>
              <CardDescription>
                {formatCount(rows.length)} grouped results. Data as of{' '}
                {data ? formatDateTime(data.dataAsOf) : ''}. Context composition
                is a local estimate; input tokens are provider-reported.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="capitalize">
                      {filters.group}
                    </TableHead>
                    {filters.group === 'provider' ||
                    filters.group === 'model' ? (
                      <TableHead>Observed provider/model</TableHead>
                    ) : null}
                    <TableHead className="text-right">Events</TableHead>
                    <TableHead className="text-right">Input tokens</TableHead>
                    <TableHead className="text-right">Cached input</TableHead>
                    <TableHead className="text-right">Cache write</TableHead>
                    <TableHead className="text-right">Output tokens</TableHead>
                    <TableHead className="text-right">Reasoning</TableHead>
                    <TableHead className="text-right">Pages</TableHead>
                    <TableHead className="text-right">OCR pages</TableHead>
                    <TableHead className="text-right">Parse CPU ms</TableHead>
                    <TableHead className="text-right">
                      Parse elapsed ms
                    </TableHead>
                    <TableHead className="text-right">System</TableHead>
                    <TableHead className="text-right">Tools</TableHead>
                    <TableHead className="text-right">Conversation</TableHead>
                    <TableHead className="text-right">Input delta</TableHead>
                    <TableHead className="text-right">Credits</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, index) => (
                    <TableRow key={`${row.key}:${index}`}>
                      <TableCell
                        className={
                          filters.group === 'user' ? 'font-mono text-xs' : ''
                        }
                      >
                        {groupValue(row, filters.group)}
                      </TableCell>
                      {filters.group === 'provider' ||
                      filters.group === 'model' ? (
                        <TableCell className="text-muted-foreground text-xs">
                          {row.observed || '—'}
                        </TableCell>
                      ) : null}
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.events)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.inputTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.cachedReadTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.cacheWriteTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.outputTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.reasoningTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.parsePages)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.parseOcrPages)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.parseCpuMilliseconds)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.parseElapsedMilliseconds)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.contextSystemTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.contextToolTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.contextConversationTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.inputTokens - row.contextTotalTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCredits(row.creditMicros)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
