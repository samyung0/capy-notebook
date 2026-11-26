import { memo, Suspense, useMemo, useState } from 'react';
import {
  useDeleteAllDrawings,
  useDeleteDrawing,
  useMarkedDrawings,
} from '@/api/hooks';
import type { MarkedDrawing } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import {
  ITEM_LIST_COLUMNS,
  ItemCard,
  ItemList,
  ItemSkeletonGrid,
} from '@/components/app/ItemCard';
import { ListEnd } from '@/components/app/ListEnd';
import { ListToolbar, type ListView } from '@/components/app/ListToolbar';
import { PageBody } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { WorkspaceCell } from '@/components/app/WorkspaceCell';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { formatFileSize } from '@/features/files/fileUtils';
import { useHeaderAction } from '@/features/files/headerAction';
import { useTabFilters } from '@/features/files/tabFilters';
import { DrawingBoardScreen } from '@/features/materials/blockCode';
import { relativeTime } from '@/features/materials/MaterialListCard';
import {
  DrawingPreview,
  drawingPreviewUrl,
  useDrawingBoard,
} from '@/features/quizzes/drawing/DrawingPreview';
import {
  DRAWING_DELETED,
  fetchDrawingPicture,
} from '@/features/quizzes/drawing/drawingBoards';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/errors';
import { waitsForConnection } from '@/lib/online';

/**
 * Files › Canvas (Epo 2026-11-06, mocks S2 list and S3 grid): the drawn answers
 * the caller pays for whose parts are marked, newest first, so they can delete
 * them; marks stay. Only practice drawings: an assignment's is free and kept as
 * handed in, on its results (Epo 2026-11-25). Each is named by its quiz, with
 * no score, and drawn from its board, as material previews draw from their
 * data. The Files toolbar with Location and Workspace filters and Delete all;
 * a drawing opens its own board, read only (Epo 2026-11-26).
 */
export function CanvasTab({
  headerSlot,
  view,
  onViewChange,
}: {
  /** Where Delete all goes on phones. */
  headerSlot: HTMLElement | null;
  view: ListView;
  onViewChange: (view: ListView) => void;
}) {
  const tab = useTabFilters();
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
  } = useMarkedDrawings(true, tab.params);
  const { mutate: deleteOne, isPending: deletingOne } = useDeleteDrawing();
  const { mutate: deleteAll, isPending: deletingAll } = useDeleteAllDrawings();
  const [confirm, setConfirm] = useState<MarkedDrawing | 'all' | null>(null);
  const [opened, setOpened] = useState<MarkedDrawing | null>(null);
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  // Every drawing's, whatever the filters keep: Delete all deletes them all.
  const count = data?.pages[0]?.count ?? 0;
  const busy = deletingOne || deletingAll;
  const iconOf = (workspaceId?: string) =>
    tab.workspaces.find((ws) => ws.id === workspaceId)?.iconId;

  const header = useHeaderAction(
    headerSlot,
    <Button
      className="px-2.5"
      disabled={busy || count === 0}
      iconLeft="trash"
      onClick={() => setConfirm('all')}
      variant="danger-light"
    >
      {m.canvas_delete_all()}
    </Button>
  );

  if (waitsForConnection(fetchStatus, data)) return <QueryPausedState />;
  if (isError && !data) {
    return (
      <ErrorState
        className="py-16"
        // Its own title and Retry: the description's action is a toast's.
        description={describeError(error).description}
        icon={describeError(error).icon}
        onRetry={() => refetch()}
        title={m.canvas_load_failed()}
        variant="panel"
      />
    );
  }
  return (
    <>
      {header.portal}
      <ListToolbar
        action={header.toolbarAction}
        filters={tab.filters}
        onResetFilters={tab.reset}
        onViewChange={onViewChange}
        view={view}
      />
      <PageBody belowToolbar>
        <div className="flex flex-col gap-3">
          {isLoading ? (
            view === 'grid' ? (
              <ItemSkeletonGrid count={8} />
            ) : (
              <SkeletonCardGrid cardHeight={76} count={3} />
            )
          ) : items.length === 0 ? (
            <p className="text-fg-muted">
              {tab.filtered ? m.common_no_matches() : m.canvas_empty()}
            </p>
          ) : (
            <ItemList
              columns={[
                m.list_col_name(),
                m.create_filter_workspace(),
                m.common_size(),
                m.files_sort_added(),
              ]}
              view={view}
            >
              {items.map((item) =>
                view === 'grid' ? (
                  <CanvasCard
                    item={item}
                    key={item.id}
                    onDelete={setConfirm}
                    onOpen={setOpened}
                    workspaceIconId={iconOf(item.workspaceId)}
                  />
                ) : (
                  <CanvasRow
                    item={item}
                    key={item.id}
                    onDelete={setConfirm}
                    onOpen={setOpened}
                    workspaceIconId={iconOf(item.workspaceId)}
                  />
                )
              )}
            </ItemList>
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
                ? m.canvas_delete_all_body({ count })
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
      {opened && (
        <OpenedDrawing item={opened} onClose={() => setOpened(null)} />
      )}
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

/** A drawing's ⋮: Delete. The row or card itself opens the drawing (Epo
 * 2026-11-26: no Open result). */
function CanvasMenu({
  item,
  onDelete,
}: {
  item: MarkedDrawing;
  onDelete: (item: MarkedDrawing) => void;
}) {
  return (
    <Menu
      items={[
        {
          danger: true,
          icon: 'trash',
          label: m.canvas_delete(),
          onClick: () => onDelete(item),
        },
      ]}
    />
  );
}

/** The stored board of a listed drawing, or null while it loads or once gone. */
function useListedBoard(id: string) {
  const board = useDrawingBoard({ drawing: id });
  return board === DRAWING_DELETED ? null : board;
}

/** A listed drawing's own board, full screen and read only, as a checked
 * answer's Open canvas shows it: its question named in the corner. */
function OpenedDrawing({
  item,
  onClose,
}: {
  item: MarkedDrawing;
  onClose: () => void;
}) {
  const board = useListedBoard(item.id);
  const question = questionLabel(item);
  if (!board) return null;
  return (
    <Suspense fallback={null}>
      <DrawingBoardScreen
        onClose={onClose}
        pictures={{ load: (id) => fetchDrawingPicture(item.id, id) }}
        pinned={{
          body: <p className="t-meta text-fg-muted">{item.quizName}</p>,
          marks: '',
          short: question,
          summary: item.quizName,
          title: question,
        }}
        readOnly
        saved={board}
      />
    </Suspense>
  );
}

type CanvasItemProps = {
  item: MarkedDrawing;
  onDelete: (item: MarkedDrawing) => void;
  onOpen: (item: MarkedDrawing) => void;
  workspaceIconId?: string;
};

/** S3: the file card, the drawing drawn in its preview. */
const CanvasCard = memo(function CanvasCard({
  item,
  onDelete,
  onOpen,
  workspaceIconId,
}: CanvasItemProps) {
  const board = useListedBoard(item.id);
  // The card's 16:11 preview box, the drawing framed by its panel (S3).
  const thumbnailUrl = useMemo(
    () =>
      board ? (drawingPreviewUrl(board, 220, 152, 12) ?? undefined) : undefined,
    [board]
  );
  return (
    <ItemCard
      actions={<CanvasMenu item={item} onDelete={onDelete} />}
      icon="drawing"
      meta={relativeTime(item.createdAt)}
      onOpen={() => onOpen(item)}
      thumbnail={{ thumbnailUrl }}
      title={item.quizName}
      view="grid"
      workspace={item.workspaceName}
      workspaceIconId={workspaceIconId}
    />
  );
});

/** S2: a list row on the Files list's columns, taller for its drawing (Epo
 * 2026-11-26): the drawing, the quiz and its question, then the workspace,
 * size and date. Phones keep two lines, as every list row: the quiz, then
 * question · workspace · size. */
const CanvasRow = memo(function CanvasRow({
  item,
  onDelete,
  onOpen,
  workspaceIconId,
}: CanvasItemProps) {
  const board = useListedBoard(item.id);
  const size = formatFileSize(item.bytes);
  return (
    <div
      className={cn(
        'relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 border-divider border-b py-2 text-sm hover:bg-surface-hover-bg md:gap-3',
        ITEM_LIST_COLUMNS
      )}
      data-item
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid h-12 w-18 shrink-0 place-items-center">
          {board && (
            <DrawingPreview
              board={board}
              className="max-h-12 object-contain"
              height={48}
              width={72}
            />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <button
            className="truncate text-left after:absolute after:inset-0 after:z-1 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset"
            onClick={() => onOpen(item)}
            type="button"
          >
            {item.quizName}
          </button>
          <span className="t-meta truncate text-fg-muted">
            {questionLabel(item)}
            <span className="md:hidden">
              {[item.workspaceName, size]
                .filter(Boolean)
                .map((part) => ` · ${part}`)
                .join('')}
            </span>
          </span>
        </div>
      </div>
      <div className="hidden min-w-0 md:block">
        {item.workspaceName && (
          <WorkspaceCell iconId={workspaceIconId} name={item.workspaceName} />
        )}
      </div>
      <p className="hidden md:block">{size}</p>
      <p className="hidden md:block">{relativeTime(item.createdAt)}</p>
      <div className="relative z-10 -my-2 flex justify-self-end">
        <CanvasMenu item={item} onDelete={onDelete} />
      </div>
    </div>
  );
});
