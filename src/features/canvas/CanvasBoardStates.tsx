import { QueryPausedState } from '@/components/app/QueryPausedState';
import { SaveBanner } from '@/components/banners/SaveBanner';
import {
  FileError,
  FileLoading,
  UnavailableItem,
} from '@/features/files/FileStates';
import { m } from '@/i18n';
import type { CanvasBoardState } from './useCanvasBoard';

/** What a canvas shows in place of its board: the room refused this person
 * (never saying blocked rather than gone, as any item), the canvas couldn't
 * open (with Retry), nothing has shown and the device is offline, or the
 * room is joining (the loader a file's pane has). */
export function CanvasBoardPanel({
  onRetry,
  state: { failed, opening, unavailable, waiting },
}: {
  onRetry: () => void;
  state: CanvasBoardState;
}) {
  if (unavailable) return <UnavailableItem />;
  if (failed) return <FileError message={failed} onRetry={onRetry} />;
  if (waiting) return <QueryPausedState className="h-full" />;
  if (opening) return <CanvasOpening />;
  return null;
}

/** A canvas on its way: the loader a file's pane has. Its page shows it too
 * while it finds which canvas to show (the list, a first canvas being made). */
export function CanvasOpening() {
  return <FileLoading message={m.common_loading()} />;
}

/** The room's strip over the board, under the picker's row: offline, an
 * outdated build, edits open for copying, access lost. The board under it is
 * read-only whenever the strip says it takes no edits. */
export function CanvasBoardStrip({
  strip,
}: {
  strip: CanvasBoardState['strip'];
}) {
  if (!strip) return null;
  return (
    <div className="absolute inset-x-2 top-12 z-10 overflow-hidden rounded-lg border border-line">
      <SaveBanner onReload={strip.onReload} state={strip.state} />
    </div>
  );
}
