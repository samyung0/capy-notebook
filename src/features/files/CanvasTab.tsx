import { Link, useNavigate } from '@tanstack/react-router';
import { memo, useMemo, useState } from 'react';
import {
  useDeleteAllDrawings,
  useDeleteDrawing,
  useMarkedDrawings,
  useWorkspaces,
} from '@/api/hooks';
import type { MarkedDrawing } from '@/api/types';
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
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { formatFileSize } from '@/features/files/fileUtils';
import { relativeTime } from '@/features/materials/MaterialListCard';
import {
  DrawingPreview,
  drawingPreviewUrl,
  useDrawingBoard,
} from '@/features/quizzes/drawing/DrawingPreview';
import { DRAWING_DELETED } from '@/features/quizzes/drawing/drawingBoards';
import { m } from '@/i18n';
import { describeError } from '@/lib/errors';
import { waitsForConnection } from '@/lib/online';

/**
 * Files › Canvas (Epo 2026-11-06, mocks S2 list and S3 grid): the drawn answers
 * the caller pays for whose parts are marked, newest first, so they can delete
 * them; marks stay. Each is named by its quiz, with no score, and drawn from its
 * board, as material previews draw from their data.
 */
export function CanvasTab({
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
  } = useMarkedDrawings(true);
  const { data: workspaces = [] } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const { mutate: deleteOne, isPending: deletingOne } = useDeleteDrawing();
  const { mutate: deleteAll, isPending: deletingAll } = useDeleteAllDrawings();
  const [confirm, setConfirm] = useState<MarkedDrawing | 'all' | null>(null);
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
        title={m.canvas_load_failed()}
        variant="panel"
      />
    );
  }
  return (
    <>
      <div className="page-px -mb-3 flex items-center gap-3">
        {first && first.count > 0 && (
          <p className="t-meta text-fg-muted">
            {m.canvas_summary({
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
            <p className="text-fg-muted">{m.canvas_empty()}</p>
          ) : view === 'grid' ? (
            <ItemGrid>
              {items.map((item) => (
                <CanvasCard
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
                <CanvasRow item={item} key={item.id} onDelete={setConfirm} />
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
                ? m.canvas_delete_all_body({ count: first?.count ?? 0 })
                : m.canvas_delete_body({ name: confirm?.quizName ?? '' })
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
                ? m.canvas_delete_all_title()
                : m.canvas_delete_title()
            }
          />
        </div>
      </PageBody>
    </>
  );
}

/** "Question 1 (a)": the part's letter only when its question has several. */
function questionLabel(item: MarkedDrawing) {
  return item.part
    ? m.canvas_question_part({
        number: item.question,
        part: String.fromCharCode(96 + item.part),
      })
    : m.canvas_question({ number: item.question });
}

const resultLink = (item: MarkedDrawing) =>
  ({
    params: { attemptId: item.attemptId },
    to: '/quizzes/attempts/$attemptId',
  }) as const;

function CanvasMenu({
  item,
  onDelete,
  view,
}: {
  item: MarkedDrawing;
  onDelete: (item: MarkedDrawing) => void;
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
          label: m.canvas_delete(),
          onClick: () => onDelete(item),
        },
      ]}
      triggerIcon={itemMenuIcon(view)}
    />
  );
}

/** The stored board of a listed drawing, or null while it loads or once gone. */
function useListedBoard(id: string) {
  const board = useDrawingBoard({ drawing: id });
  return board === DRAWING_DELETED ? null : board;
}

/** S3: the file card, the drawing drawn in its preview. */
const CanvasCard = memo(function CanvasCard({
  item,
  onDelete,
  workspaceIconId,
}: {
  item: MarkedDrawing;
  onDelete: (item: MarkedDrawing) => void;
  workspaceIconId?: string;
}) {
  const board = useListedBoard(item.id);
  // The card's 16:11 preview box, the drawing framed by its panel (S3).
  const thumbnailUrl = useMemo(
    () =>
      board ? (drawingPreviewUrl(board, 220, 152, 12) ?? undefined) : undefined,
    [board]
  );
  return (
    <ItemCard
      actions={<CanvasMenu item={item} onDelete={onDelete} view="grid" />}
      icon="drawing"
      link={resultLink(item)}
      meta={relativeTime(item.createdAt)}
      thumbnail={{ thumbnailUrl }}
      title={item.quizName}
      view="grid"
      workspace={item.workspaceName}
      workspaceIconId={workspaceIconId}
    />
  );
});

/** S2: a list row, its second line naming the question, practice or
 * assignment, and the workspace. */
const CanvasRow = memo(function CanvasRow({
  item,
  onDelete,
}: {
  item: MarkedDrawing;
  onDelete: (item: MarkedDrawing) => void;
}) {
  const board = useListedBoard(item.id);
  const when = relativeTime(item.createdAt);
  const size = formatFileSize(item.bytes);
  return (
    <div
      className="relative grid min-h-19 grid-cols-[72px_minmax(0,1fr)_36px] items-center gap-3 border-divider border-b py-2 text-sm hover:bg-surface-hover-bg md:grid-cols-[96px_minmax(0,1fr)_140px_90px_36px]"
      data-item
    >
      <div className="grid h-15 place-items-center">
        {board && (
          <DrawingPreview
            board={board}
            className="max-h-15 object-contain"
            height={60}
            width={94}
          />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <Link
          {...resultLink(item)}
          className="truncate after:absolute after:inset-0 after:z-1 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset"
        >
          {item.quizName}
        </Link>
        <span className="t-meta truncate text-fg-muted">
          {[
            questionLabel(item),
            item.assignment ? m.canvas_assignment() : m.canvas_practice(),
            item.workspaceName,
          ]
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
        <CanvasMenu item={item} onDelete={onDelete} view="list" />
      </div>
    </div>
  );
});
