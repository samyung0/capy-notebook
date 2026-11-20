/* Draws a graph block onto its canvas with the engine, at the canvas's shown
 * width and the screen's density, again whenever that width changes. Loaded
 * by GraphView in an effect: the share Worker's build gets an empty module
 * for it (vite.config.ts BROWSER_ONLY), keeping the engine out of the Worker. */
import { drawGraph } from '@/features/graph/draw';
import { PAPER } from '@/features/graph/paper';
import { viewOf } from '@/features/graph/view';
import type { GraphBlock } from './types';

/** KaTeX, which Preview loads ahead for a graph's formulas (blockCode's
 * katexCode). */
export { loadKatex } from '@/features/graph/formula';

/** Paints `graph` on `canvas` in the light or dark paper and keeps it painted
 * as the canvas resizes; the returned function stops that. */
export function paintGraph(
  canvas: HTMLCanvasElement,
  graph: GraphBlock,
  dark: boolean
): () => void {
  const { width, height } = graph;
  const view = viewOf(graph.board.bbox, width, height);
  const paper = dark ? PAPER.dark : PAPER.light;
  let frame = 0;
  const paint = () => {
    frame = 0;
    const shown = canvas.clientWidth;
    const ctx = canvas.getContext('2d');
    // Not laid out yet (a closed section): painted once it is.
    if (!(shown && ctx)) return;
    const k = (shown * window.devicePixelRatio) / width;
    canvas.width = Math.round(width * k);
    canvas.height = Math.round(height * k);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawGraph(
      ctx,
      { h: height, w: width, x: 0, y: 0 },
      view,
      graph,
      paper,
      // A formula laid out after the first paint.
      () => {
        frame ||= requestAnimationFrame(paint);
      }
    );
  };
  let drawnAt = -1;
  const observer = new ResizeObserver(() => {
    if (canvas.clientWidth === drawnAt) return;
    drawnAt = canvas.clientWidth;
    paint();
  });
  observer.observe(canvas);
  drawnAt = canvas.clientWidth;
  paint();
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
}
