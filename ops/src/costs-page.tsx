import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { CostGroup } from './api';
import { useOpsApp } from './app-context';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
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
  formatCredits,
  formatNumber,
  MetricCard,
  PageHeader,
  PageSkeleton,
  POLL_INTERVAL,
} from './ops-ui';

const groups: { value: CostGroup; label: string }[] = [
  { label: 'Day', value: 'day' },
  { label: 'User', value: 'user' },
  { label: 'Kind', value: 'kind' },
  { label: 'Surface', value: 'surface' },
  { label: 'Provider', value: 'provider' },
  { label: 'Model', value: 'model' },
];

export function CostsPage() {
  const { api } = useOpsApp();
  const search = useSearch({ from: '/costs' });
  const navigate = useNavigate({ from: '/costs' });
  const [from, setFrom] = useState(search.from);
  const [to, setTo] = useState(search.to);
  const [invoice, setInvoice] = useState('');
  useEffect(() => {
    setFrom(search.from);
    setTo(search.to);
  }, [search.from, search.to]);

  const {
    data = [],
    error,
    isError,
    isPending,
  } = useQuery({
    queryFn: () => api.costs(search.from, search.to, search.groupBy),
    queryKey: ['ops', 'costs', search],
    refetchInterval: POLL_INTERVAL,
  });
  const chargedMicros = data.reduce(
    (total, row) => total + row.creditMicros,
    0
  );
  const invoiceAmount = Number(invoice);
  const invoiceIsValid =
    invoice.trim() !== '' && Number.isFinite(invoiceAmount);

  return (
    <div className="space-y-6">
      <PageHeader
        description="Compare metered credits with provider invoices. Invoice amounts stay in this browser session and are never saved."
        title="Cost explorer"
      />
      <Card>
        <CardHeader>
          <CardTitle>Query</CardTitle>
          <CardDescription>
            Dates and grouping are stored in the URL for reproducible views.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              navigate({
                search: {
                  from,
                  groupBy: search.groupBy,
                  to,
                },
              });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="cost-from">From</Label>
              <Input
                id="cost-from"
                onChange={(event) => setFrom(event.currentTarget.value)}
                type="date"
                value={from}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cost-to">To</Label>
              <Input
                id="cost-to"
                onChange={(event) => setTo(event.currentTarget.value)}
                type="date"
                value={to}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cost-group">Group by</Label>
              <Select
                onValueChange={(groupBy: CostGroup) =>
                  navigate({ search: { ...search, groupBy } })
                }
                value={search.groupBy}
              >
                <SelectTrigger id="cost-group">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((group) => (
                    <SelectItem key={group.value} value={group.value}>
                      {group.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button className="w-full" type="submit">
                Apply dates
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {isPending ? (
        <PageSkeleton />
      ) : isError ? (
        <ErrorState error={error} />
      ) : (
        <>
          <section
            aria-label="Invoice comparison"
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            <MetricCard
              detail={`${formatNumber(data.length)} grouped rows`}
              label="Charged credits"
              value={formatCredits(chargedMicros)}
            />
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>
                  Provider invoice, manual comparison
                </CardDescription>
                <CardTitle>
                  <Label className="sr-only" htmlFor="invoice-amount">
                    Provider invoice amount
                  </Label>
                  <Input
                    id="invoice-amount"
                    inputMode="decimal"
                    min="0"
                    onChange={(event) => setInvoice(event.currentTarget.value)}
                    placeholder="0.00"
                    step="0.01"
                    type="number"
                    value={invoice}
                  />
                </CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-xs">
                Not persisted or sent to the API.
              </CardContent>
            </Card>
            <MetricCard
              detail="Policy credit micros per pasted invoice unit; these are intentionally not treated as the same currency."
              label="Policy / invoice ratio"
              value={
                invoiceIsValid && invoiceAmount > 0
                  ? new Intl.NumberFormat('en-US', {
                      maximumFractionDigits: 0,
                    }).format(chargedMicros / invoiceAmount)
                  : 'Enter invoice'
              }
            />
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Grouped usage</CardTitle>
              <CardDescription>
                Up to 500 rows from usage_daily, grouped by {search.groupBy}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.length === 0 ? (
                <EmptyState
                  description="No daily usage rows matched this date range."
                  title="No costs found"
                />
              ) : (
                <Table>
                  <TableCaption>
                    Usage from {search.from} through {search.to}, grouped by{' '}
                    {search.groupBy}.
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{search.groupBy}</TableHead>
                      <TableHead className="text-right" scope="col">
                        Events
                      </TableHead>
                      <TableHead className="text-right" scope="col">
                        Input tokens
                      </TableHead>
                      <TableHead className="text-right" scope="col">
                        Output tokens
                      </TableHead>
                      <TableHead className="text-right" scope="col">
                        Units
                      </TableHead>
                      <TableHead className="text-right" scope="col">
                        Credits
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.map((row) => (
                      <TableRow key={row.key}>
                        <TableCell className="font-medium">{row.key}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNumber(row.events)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNumber(row.inputTokens)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNumber(row.outputTokens)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNumber(row.units)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCredits(row.creditMicros)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
