import { Link, useNavigate } from '@tanstack/react-router';
import { memo, useState } from 'react';
import {
  useDeleteAllPapers,
  useDeletePaper,
  useSubmittedPapers,
  useWorkspaces,
} from '@/api/hooks';
import type { SourceFile, SubmittedPaper } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import {
  ItemCard,
  ItemGrid,
  ItemSkeletonGrid,
  itemMenuIcon,
} from '@/components/app/ItemCard';
import { ListEnd } from '@/components/app/ListEnd';
import { type ListView, ListViewToggle } from '@/components/app/ListToolbar';
import { PageBody } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button, ErrorAction } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { formatFileSize } from '@/features/files/fileUtils';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import { describeError } from '@/lib/errors';
import { fileIconName } from '@/lib/fileIcons';
import { waitsForConnection } from '@/lib/online';

/**
 * Files › Submissions (Epo 2026-11-08, mock F1): the papers the caller handed
 * in, once marked and their assignment closed with grades out, newest first, so
 * they can delete them; marks stay. Built as Files › Canvas is.
 */
export function SubmissionsTab({
  view,
  onViewChange,
}: {
  view: ListView;
  onViewChange: (view: ListView) => void;
}) {
  const {
    data,
    error,
    fetchNextPage,
    fetchStatus,
    hasNextPage,
    isError,
    isFetchNextPageError,
    isFetchingNextPage,
    isLoading,
    refetch,
  } = useSubmittedPapers(true);
  const { data: workspaces = [] } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const { mutate: deleteOne, isPending: deletingOne } = useDeletePaper();
  const { mutate: deleteAll, isPending: deletingAll } = useDeleteAllPapers();
  const [confirm, setConfirm] = useState<SubmittedPaper | 'all' | null>(null);
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const first = data?.pages[0];
  const busy = deletingOne || deletingAll;

  if (waitsForConnection(fetchStatus, data)) return <QueryPausedState />;
  if (isError && !data) {
    return (
      <ErrorState
        {...describeError(error)}
        action={
          <ErrorAction onClick={() => refetch()}>{m.trash_retry()}</ErrorAction>
        }
        className="py-16"
        title={m.submissions_load_failed()}
        variant="panel"
      />
    );
  }
  return (
    <>
      <div className="page-px -mb-3 flex items-center gap-3">
        {first && first.count > 0 && (
          <p className="t-meta text-fg-muted">
            {m.submissions_summary({
              count: first.count,
              size: formatFileSize(first.totalBytes),
            })}
          </p>
        )}
        {/* -mr-1.5: the view toggle's icon on the gutter, as in ListToolbar. */}
        <div className="-mr-1.5 ml-auto flex min-h-10 items-center gap-1 sm:min-h-11.5">
          <Button
            className="px-1.5"
            disabled={busy || items.length === 0}
            iconLeft="trash"
            onClick={() => setConfirm('all')}
            size="sm"
            variant="danger-light"
          >
            {m.canvas_delete_all()}
          </Button>
          <ListViewToggle onViewChange={onViewChange} view={view} />
        </div>
      </div>
      <PageBody belowToolbar>
        <div className="flex flex-col gap-3">
          {isLoading ? (
            view === 'grid' ? (
              <ItemSkeletonGrid count={8} />
            ) : (
              <SkeletonCardGrid cardHeight={76} count={3} />
            )
          ) : items.length === 0 ? (
            <p className="text-fg-muted">{m.submissions_empty()}</p>
          ) : view === 'grid' ? (
            <ItemGrid>
              {items.map((item) => (
                <SubmissionCard
                  item={item}
                  key={item.id}
                  onDelete={setConfirm}
                  workspaceIconId={
                    workspaces.find((ws) => ws.id === item.workspaceId)?.iconId
                  }
                />
              ))}
            </ItemGrid>
          ) : (
            <div className="flex flex-col">
              {items.map((item) => (
                <SubmissionRow
                  item={item}
                  key={item.id}
                  onDelete={setConfirm}
                />
              ))}
            </div>
          )}
          <ListEnd
            fetchNextPage={fetchNextPage}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetchNextPageError={isFetchNextPageError}
          />
          <ConfirmDialog
            body={
              confirm === 'all'
                ? m.submissions_delete_all_body({ count: first?.count ?? 0 })
                : m.submissions_delete_body({ name: confirm?.name ?? '' })
            }
            confirmLabel={
              confirm === 'all' ? m.canvas_delete_all() : m.canvas_delete()
            }
            onClose={() => setConfirm(null)}
            onConfirm={() => {
              if (confirm === 'all') deleteAll();
              else if (confirm) deleteOne(confirm.id);
            }}
            open={!!confirm}
            title={
              confirm === 'all'
                ? m.submissions_delete_all_title()
                : m.submissions_delete_title()
            }
          />
        </div>
      </PageBody>
    </>
  );
}

const resultLink = (item: SubmittedPaper) =>
  ({
    params: { attemptId: item.attemptId },
    to: '/quizzes/attempts/$attemptId',
  }) as const;

const iconOf = (item: SubmittedPaper) =>
  fileIconName(item as Pick<SourceFile, 'kind' | 'name'>);

function SubmissionMenu({
  item,
  onDelete,
  view,
}: {
  item: SubmittedPaper;
  onDelete: (item: SubmittedPaper) => void;
  view: ListView;
}) {
  const navigate = useNavigate();
  return (
    <Menu
      items={[
        {
          icon: 'navigationForward',
          label: m.canvas_open_result(),
          onClick: () => void navigate(resultLink(item)),
        },
        {
          danger: true,
          icon: 'trash',
          label: m.submissions_delete(),
          onClick: () => onDelete(item),
        },
      ]}
      triggerIcon={itemMenuIcon(view)}
    />
  );
}

/** F1's card. */
const SubmissionCard = memo(function SubmissionCard({
  item,
  onDelete,
  workspaceIconId,
}: {
  item: SubmittedPaper;
  onDelete: (item: SubmittedPaper) => void;
  workspaceIconId?: string;
}) {
  return (
    <ItemCard
      actions={<SubmissionMenu item={item} onDelete={onDelete} view="grid" />}
      icon={iconOf(item)}
      link={resultLink(item)}
      meta={relativeTime(item.createdAt)}
      title={item.name}
      view="grid"
      workspace={item.workspaceName}
      workspaceIconId={workspaceIconId}
    />
  );
});

/** F1's row: the file, then its assignment and workspace. */
const SubmissionRow = memo(function SubmissionRow({
  item,
  onDelete,
}: {
  item: SubmittedPaper;
  onDelete: (item: SubmittedPaper) => void;
}) {
  const when = relativeTime(item.createdAt);
  const size = formatFileSize(item.bytes);
  return (
    <div
      className="relative grid min-h-19 grid-cols-[72px_minmax(0,1fr)_36px] items-center gap-3 border-divider border-b py-2 text-sm hover:bg-surface-hover-bg md:grid-cols-[96px_minmax(0,1fr)_140px_90px_36px]"
      data-item
    >
      <div className="grid h-15 place-items-center">
        <FileIcon className="size-9" name={iconOf(item)} />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <Link
          {...resultLink(item)}
          className="truncate after:absolute after:inset-0 after:z-1 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset"
        >
          {item.name}
        </Link>
        <span className="t-meta truncate text-fg-muted">
          {[item.quizName, m.canvas_assignment(), item.workspaceName]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {/* Phones fold the time and size columns into a third line. */}
        <span className="t-meta truncate text-fg-muted md:hidden">
          {`${when} · ${size}`}
        </span>
      </div>
      <span className="t-meta hidden text-fg-muted md:block">{when}</span>
      <span className="t-meta hidden text-right text-fg-muted md:block">
        {size}
      </span>
      <div className="relative z-10 flex justify-self-end">
        <SubmissionMenu item={item} onDelete={onDelete} view="list" />
      </div>
    </div>
  );
});
