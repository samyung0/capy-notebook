import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import { toBase64 } from '@/features/blocksuite/base64';
import { drawBoardPreview } from '@/features/blocksuite/boardPreview';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { Answer } from '../grade';
import { isDrawingValue } from './drawingValue';

/** A stored drawing's id, as an answer names it once the server keeps it. */
export const storedDrawingId = (value: Answer) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof value.drawing === 'string' &&
  value.drawing !== ''
    ? value.drawing
    : null;

/** Stored boards fetched in this page, by drawing id. */
const fetched = new Map<string, Promise<string>>();

const fetchBoard = (id: string) => {
  let board = fetched.get(id);
  if (!board) {
    board = api
      .get<{ boardUrl: string }>(`/drawings/${id}`)
      .then((drawing) => fetch(drawing.boardUrl))
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`board fetch failed: ${response.status}`);
        return toBase64(new Uint8Array(await response.arrayBuffer()));
      });
    // A failure is fetched again on the next view, not retried here.
    board.catch(() => fetched.delete(id));
    fetched.set(id, board);
  }
  return board;
};

/** A drawing answer's board, base64: the device's, or the stored one fetched
 * through its hour-long link (the member and the assignment's staff only).
 * Shared pages have no stored drawings, so they never fetch. */
export function useDrawingBoard(value: Answer) {
  const local = isDrawingValue(value) ? value.board : null;
  const id = local ? null : storedDrawingId(value);
  const [stored, setStored] = useState<{ board: string; id: string } | null>(
    null
  );
  useEffect(() => {
    if (!id) return;
    let live = true;
    fetchBoard(id)
      .then((board) => live && setStored({ board, id }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id]);
  return local ?? (stored && stored.id === id ? stored.board : null);
}

/**
 * A drawing drawn from its board, the way material previews draw from their data
 * (Epo 2026-11-06): no picture is stored, and the editor isn't loaded. The same
 * drawing shows in the answer area, results, Approve and the Canvas tab.
 */
export function DrawingPreview({
  board,
  className,
  height = 300,
  width = 520,
}: {
  board: string;
  className?: string;
  height?: number;
  width?: number;
}) {
  const src = useMemo(() => {
    try {
      const svg = drawBoardPreview(board, { height, width });
      return `data:image/svg+xml,${encodeURIComponent(svg)}`;
    } catch {
      return null;
    }
  }, [board, height, width]);
  if (!src)
    return (
      <p className={cn('t-meta text-fg-muted', className)}>
        {m.drawing_answer_unreadable()}
      </p>
    );
  return (
    <img
      alt={m.drawing_answer_image()}
      className={cn('h-auto max-w-full', className)}
      height={height}
      src={src}
      width={width}
    />
  );
}
