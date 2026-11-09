import {
  getStroke,
  getSvgPathFromStroke,
  type IVec,
} from '@blocksuite/affine/global/gfx';

/** How wide the eraser is on the board and in an open card: BlockSuite's trail, and the
 * ring the pointer shows (Epo 2026-11-09). */
export const ERASER_SIZE = 16;
/** BlockSuite drops a tenth of the trail's tail this often. */
const TRAIL_STEP_MS = 32;

/** BlockSuite's eraser trail, for a card's own canvas: it follows the press and shrinks
 * from its tail until only its head is left, and goes when the press lifts. */
export class EraserTrail {
  private points: IVec[] = [];
  private shortened = 0;
  private readonly redraw: () => void;

  constructor(redraw: () => void) {
    this.redraw = redraw;
  }

  start(at: IVec) {
    this.points = [at];
    this.shortened = performance.now();
    this.redraw();
  }

  add(at: IVec) {
    if (!this.points.length) return;
    this.points.push(at);
    this.redraw();
  }

  end() {
    this.points = [];
    this.redraw();
  }

  /** In BlockSuite's grey; asks for the next frame while it's still shrinking. */
  draw(ctx: CanvasRenderingContext2D) {
    if (!this.points.length) return;
    const now = performance.now();
    if (now - this.shortened > TRAIL_STEP_MS && this.points.length > 1) {
      this.points.splice(0, Math.ceil(this.points.length * 0.1));
      this.shortened = now;
    }
    ctx.save();
    ctx.globalAlpha = 0.33;
    ctx.fillStyle = '#aaa';
    ctx.fill(
      new Path2D(
        getSvgPathFromStroke(
          getStroke(this.points, { size: ERASER_SIZE, start: { taper: true } })
        )
      )
    );
    ctx.restore();
    if (this.points.length > 1) this.redraw();
  }
}

/** The pixels along a drag from one point to the next, a few apart, so a fast swipe
 * misses nothing between its pointer events. */
export function alongDrag(from: IVec, to: IVec): IVec[] {
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / (ERASER_SIZE / 2))
  );
  return Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  });
}
