import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { CostGroup, CostRow } from '@/api';
import { useOpsApp } from '@/app-context';
import {
  ErrorState,
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
import { formatCount, formatCredits, formatShortDate } from '@/format';

const groupOptions: { value: CostGroup; label: string }[] = [
  { label: 'Day', value: 'day' },
  { label: 'User', value: 'user' },
  { label: 'Kind', value: 'kind' },
  { label: 'Surface', value: 'surface' },
  { label: 'Provider', value: 'provider' },
  { label: 'Model', value: 'model' },
];

function isoDay(daysAgo: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

type Filters = {
  from: string;
  to: string;
  group: CostGroup;
};

function groupValue(row: CostRow, group: CostGroup): string {
  return group === 'day' ? formatShortDate(row.key) : row.key;
}

export function CostsPage() {
  const { api } = useOpsApp();
  const [draft, setDraft] = useState<Filters>({
    from: isoDay(30),
    group: 'day',
    to: isoDay(0),
  });
  const [filters, setFilters] = useState(draft);
  const [validation, setValidation] = useState('');
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryFn: () => api.costs(filters.from, filters.to, filters.group),
    queryKey: ['costs', filters.from, filters.to, filters.group],
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

  const rows = data ?? [];
  const totals = rows.reduce(
    (total, row) => ({
      creditMicros: total.creditMicros + row.creditMicros,
      events: total.events + row.events,
      inputTokens: total.inputTokens + row.inputTokens,
      outputTokens: total.outputTokens + row.outputTokens,
    }),
    { creditMicros: 0, events: 0, inputTokens: 0, outputTokens: 0 }
  );

  return (
    <>
      <PageHeader
        description="Group operational cost by any combination of date, user, workload, and model dimensions."
        title="Cost explorer"
      />

      <Card className="shadow-sm">
        <CardContent className="p-5">
          <form action="/costs" method="get" onSubmit={apply}>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="cost-from">From</Label>
                <Input
                  id="cost-from"
                  name="from"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      from: event.currentTarget.value,
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
        <PageLoading label="Loading cost report" />
      ) : error ? (
        <ErrorState error={error} retry={() => void refetch()} />
      ) : (
        <>
          <section
            aria-label="Cost report totals"
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
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
          </section>

          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Cost rows</CardTitle>
              <CardDescription>
                {formatCount(rows.length)} grouped results
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="capitalize">
                      {filters.group}
                    </TableHead>
                    <TableHead className="text-right">Events</TableHead>
                    <TableHead className="text-right">Input tokens</TableHead>
                    <TableHead className="text-right">Output tokens</TableHead>
                    <TableHead className="text-right">Units</TableHead>
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
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.events)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.inputTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.outputTokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.units)}
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
