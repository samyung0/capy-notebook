import { useState } from 'react';
import { createPortal } from 'react-dom';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { FileBanner } from '@/components/banners/FileBanner';
import { DeletedDownload, SaveBanner } from '@/components/banners/SaveBanner';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import { LiveStatus } from '@/features/collaboration/LiveItemControls';
import { useSlowedLine } from '@/features/collaboration/SlowedOpen';
import {
  FileError,
  FileLoading,
  StorageFullBanner,
  UnavailableItem,
} from '@/features/files/FileStates';
import { TrashBanner } from '@/features/files/TrashBanner';
import { OfflineStatus } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { useMediaQuery } from '@/lib/useMediaQuery';
import type { CanvasBoardState, CanvasStrip } from './useCanvasBoard';

/** What a canvas shows in place of its board: the room refused this person
 * (never saying blocked rather than gone, as any item), the canvas couldn't
 * open (with Retry and its error id), nothing has shown and the device is
 * offline, or the room is joining (the loader a file's pane has). It also puts
 * the board's save status beside the board's ☰. */
export function CanvasBoardPanel({
  onRetry,
  state,
}: {
  onRetry: () => void;
  state: CanvasBoardState;
}) {
  const { failed, opening, slowed, status, unavailable, waiting } = state;
  return (
    <>
      <CanvasBoardStatus slowed={slowed} status={status} />
      {unavailable ? (
        <UnavailableItem />
      ) : failed ? (
        <FileError
          errorId={failed.errorId}
          message={failed.message}
          onRetry={onRetry}
        />
      ) : waiting ? (
        <QueryPausedState className="h-full" />
      ) : opening ? (
        <CanvasOpening slowed={slowed} />
      ) : null}
    </>
  );
}

/** A canvas on its way: the loader a file's pane has, which says after 5 s
 * that a slowed open is slowed. Its page shows it too while it finds which
 * canvas to show (the list, a first canvas being made). */
export function CanvasOpening({ slowed = false }: { slowed?: boolean }) {
  return <FileLoading message={m.common_loading()} slowed={slowed} />;
}

/** The board's save status just left of its ☰ (Epo 2026-11-18, mock 1B): a
 * note's header icons with their label, the icon alone on a phone as a note's
 * phone header; a viewer's, as a note's viewer's header, only the offline
 * icon. A slowed open holds its tooltip open with why after 5 s, as a
 * note's status does. */
function CanvasBoardStatus({
  slowed,
  status,
}: {
  slowed: boolean;
  status: CanvasBoardState['status'];
}) {
  const phone = !useMediaQuery('(min-width: 640px)');
  const line = useSlowedLine(slowed);
  if (!status) return null;
  if (status.reads) return createPortal(<OfflineStatus />, status.slot);
  return createPortal(
    <Tooltip open={line}>
      <TooltipTrigger className="inline-flex" render={<span />}>
        {status.state === 'opening' ? (
          // Painted from the device's copy, the room still joining.
          <Spinner className="size-4" />
        ) : (
          <LiveStatus compact={phone} status={status.state} />
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">{m.editor_open_slowed()}</TooltipContent>
    </Tooltip>,
    status.slot
  );
}

/** The strip over the board, under the picker's row: the room's save strips
 * (offline, an outdated build, edits open for copying, a deleted canvas's
 * with Download, access lost, the service unreachable, saving delayed), why
 * the board is read-only, or the Trash's Restore. The board under it is read-only whenever the strip says it
 * takes no edits. A strip the person closed draws nothing, and its outline
 * goes with it (`empty:hidden`). Discard, in recovery and on the unsynced
 * strip, asks before it drops the edits, as a note's Discard does. */
export function CanvasBoardStrip({ strip }: { strip: CanvasStrip | null }) {
  const [asking, setAsking] = useState<{
    open: boolean;
    run: () => void;
  } | null>(null);
  if (!strip) return null;
  return (
    <>
      <div
        className="absolute inset-x-2 top-12 z-10 overflow-hidden rounded-lg border border-line empty:hidden"
        data-canvas-strip
      >
        {strip.kind === 'trash' ? (
          <TrashBanner
            item={{ id: strip.id, kind: 'material' }}
            trash={strip.trash}
            workspaceId={strip.workspaceId}
          />
        ) : strip.kind === 'storage' ? (
          <StorageFullBanner by={strip.by} />
        ) : strip.kind === 'read-only' ? (
          <FileBanner message={m.editor_read_only_strip()} />
        ) : (
          <DeletedDownload.Provider value={strip.onDownload ?? null}>
            <SaveBanner
              onDiscard={
                strip.onDiscard &&
                (() => {
                  const run = strip.onDiscard;
                  if (!run) return;
                  setAsking({ open: true, run });
                })
              }
              onDownload={strip.onDownload}
              onRetry={strip.onRetry}
              retrying={strip.retrying}
              state={strip.state}
            />
          </DeletedDownload.Provider>
        )}
      </div>
      <ConfirmDialog
        body={m.merge_discard_body()}
        confirmLabel={m.action_discard()}
        onClose={() => setAsking((last) => last && { ...last, open: false })}
        onConfirm={() => asking?.run()}
        open={!!asking?.open}
        title={m.canvas_reload_discard_title()}
      />
    </>
  );
}
