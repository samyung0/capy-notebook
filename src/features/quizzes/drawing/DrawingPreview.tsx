import { useEffect, useMemo, useState } from 'react';
import { drawBoardPreview } from '@/features/blocksuite/boardPreview';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { Answer } from '../grade';
import { fetchDrawingBoard } from './drawingBoards';
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

/** A drawing answer's board, base64: the device's, or the stored one fetched
 * through its hour-long link (the member and the assignment's staff only), or
 * DRAWING_DELETED once its payer deleted it. Shared pages have no stored
 * drawings, so they never fetch. */
export function useDrawingBoard(value: Answer) {
  const local = isDrawingValue(value) ? value.board : null;
  const id = local ? null : storedDrawingId(value);
  const [stored, setStored] = useState<{ board: string; id: string } | null>(
    null
  );
  useEffect(() => {
    if (!id) return;
    let live = true;
    fetchDrawingBoard(id)
      .then((board) => live && setStored({ board, id }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id]);
  return local ?? (stored && stored.id === id ? stored.board : null);
}

/** A board drawn as an SVG data URL, or null when it can't be read. With
 * `inset`, the drawing sits that far inside a transparent box of the full size,
 * so a card's own panel frames it (Files › Canvas, mock S3). */
export function drawingPreviewUrl(
  board: string,
  width: number,
  height: number,
  inset = 0
) {
  try {
    let svg = drawBoardPreview(board, {
      height: height - inset * 2,
      width: width - inset * 2,
    });
    if (inset)
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svg.replace('<svg ', `<svg x="${inset}" y="${inset}" `)}</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch {
    return null;
  }
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
  const src = useMemo(
    () => drawingPreviewUrl(board, width, height),
    [board, height, width]
  );
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
