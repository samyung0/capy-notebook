import { useRef, useState } from 'react';
import { listUsageEventsQueryLimitMax as PAGE_SIZE } from '@/api/gen/validators';
import { useUsageEvents } from '@/api/hooks';
import type { UsageEventParams, UsageEventSort } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import type { ColumnSort } from '@/components/app/SortHeader';
import { TabHeader } from '@/components/app/tabPanel';
import { ErrorAction } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { getLocale, m } from '@/i18n';
import { describeError, unexpectedErrorId } from '@/lib/errors';
import {
  type BillingColumn,
  BillingTable,
  BillingTableSkeleton,
} from './BillingTable';
import { formatCredits } from './format';
import { areaOf, kindLabel } from './labels';

// A function so labels follow the current locale. Area and Resource do not
// sort: the server would order their keys, not the translated labels.
const columns = (): BillingColumn<UsageEventSort>[] => [
  { id: 'date', label: m.billing_col_date(), muted: true, sort: 'date' },
  { id: 'area', label: m.billing_col_area() },
  { id: 'resource', label: m.billing_col_resource() },
  { clamp: true, id: 'model', label: m.billing_col_model(), sort: 'model' },
  {
    id: 'tokens',
    label: m.billing_col_tokens(),
    muted: true,
    sort: 'tokens',
  },
  {
    align: 'right',
    id: 'credits',
    label: m.billing_col_credits(),
    sort: 'credits',
  },
];

/** Ledger rows a page at a time. Pages already fetched stay cached, so
 * going back never refetches. */
export function DetailsTab() {
  const [params, setParams] = useState<UsageEventParams>({});
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isPending,
    isPlaceholderData,
    refetch,
  } = useUsageEvents(params);
  const [page, setPage] = useState(0);
  const sorting: ColumnSort<UsageEventSort> = {
    ascending: params.dir === 'asc',
    ascendingFirst: ['model'],
    onSortChange: (sort, ascending) => {
      setParams({
        dir: ascending ? 'asc' : undefined,
        sort: sort === 'date' ? undefined : sort,
      });
      setPage(0);
    },
    sort: params.sort ?? 'date',
  };
  const topRef = useRef<HTMLDivElement>(null);
  // Paging from the footer should land on the new page's first row.
  const show = (next: number) => {
    setPage(next);
    topRef.current?.scrollIntoView({ block: 'nearest' });
  };
  const pages = data?.pages ?? [];
  const items = pages[page]?.items ?? [];
  const locale = getLocale();

  const next = () => {
    if (page + 1 < pages.length) {
      show(page + 1);
      return;
    }
    void fetchNextPage().then(({ isError: failed }) => {
      if (!failed) show(page + 1);
    });
  };

  const body = isError ? (
    <ErrorState
      {...describeError(error)}
      action={
        <ErrorAction iconLeftClassName="me-1" onClick={() => void refetch()}>
          {m.error_action_retry()}
        </ErrorAction>
      }
      errorId={unexpectedErrorId(error)}
      variant="panel"
    />
  ) : isPending ? (
    <BillingTableSkeleton columns={columns()} />
  ) : items.length === 0 ? (
    <p className="text-fg-muted">{m.billing_recent_empty()}</p>
  ) : (
    <>
      <BillingTable
        columns={columns()}
        rows={items.map((ev, i) => ({
          cells: {
            area: areaOf(ev.surface).label(),
            credits: formatCredits(ev.creditMicros),
            date: new Date(ev.createdAt).toLocaleString(locale, {
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              month: 'short',
            }),
            model: ev.modelSlug ? `${ev.providerSlug}/${ev.modelSlug}` : '—',
            resource: kindLabel(ev.kind),
            tokens:
              ev.inputTokens + ev.outputTokens > 0
                ? m.billing_tokens({
                    input: ev.inputTokens.toLocaleString(locale),
                    output: ev.outputTokens.toLocaleString(locale),
                  })
                : '—',
          },
          key: `${ev.createdAt}-${ev.kind}-${i}`,
        }))}
        sorting={sorting}
      />
      <div className="flex items-center justify-between pt-4">
        <span className="t-meta text-fg-muted">
          {m.billing_events_range({
            from: String(page * PAGE_SIZE + 1),
            to: String(page * PAGE_SIZE + items.length),
          })}
        </span>
        <div className="flex gap-1">
          <IconButton
            disabled={page === 0}
            icon="navigationBack"
            label={m.action_previous()}
            onClick={() => show(page - 1)}
            size="sm"
            variant="ghost-hover"
          />
          <IconButton
            disabled={
              isPlaceholderData ||
              isFetchingNextPage ||
              (page + 1 >= pages.length && !hasNextPage)
            }
            icon="navigationForward"
            label={m.action_next()}
            onClick={next}
            size="sm"
            variant="ghost-hover"
          />
        </div>
      </div>
    </>
  );

  return (
    <>
      <div ref={topRef} />
      <TabHeader
        description={m.billing_details_hint()}
        title={m.billing_tab_details()}
      />
      {body}
    </>
  );
}
