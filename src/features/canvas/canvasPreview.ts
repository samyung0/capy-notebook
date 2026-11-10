import { useEffect, useState } from 'react';

/** A canvas's card picture for lists (Epo 2026-11-09): its saved board drawn
 * from its data, as a drawing answer's is, with no editor loaded and nothing
 * stored. The board comes from the material's board asset, which a stored
 * preview names. None until it is drawn, or when it can't be. */
export function useCanvasDrawing(boardAssetId: string | undefined) {
  const [drawn, setDrawn] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!boardAssetId) return;
    let live = true;
    // Their modules hold Yjs and the board's checks, which a list only needs
    // once it shows a canvas.
    Promise.all([
      import('@/features/blocksuite/boardAsset'),
      import('@/features/blocksuite/boardPreview'),
    ])
      .then(async ([{ boardFromAsset }, { drawBoardPreview }]) => {
        const svg = drawBoardPreview(
          await boardFromAsset(boardAssetId),
          { height: 220, width: 320 },
          'workspace'
        );
        if (live)
          setDrawn({
            id: boardAssetId,
            url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
          });
      })
      // The card keeps its icon.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [boardAssetId]);
  return drawn && drawn.id === boardAssetId ? drawn.url : undefined;
}
