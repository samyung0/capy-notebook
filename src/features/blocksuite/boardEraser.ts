import {
  getStroke,
  getSvgPathFromStroke,
  type IVec,
} from '@blocksuite/affine/global/gfx';
import { ERASER_SIZE, type Trail } from '@/features/graph/tools';

/** BlockSuite drops a tenth of the trail's tail this often. */
const TRAIL_STEP_MS = 32;

/** BlockSuite's eraser trail, for a card's own canvas: it follows the press and shrinks
 * from its tail until only its head is left, and goes when the press lifts. */
export class EraserTrail implements Trail {
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
