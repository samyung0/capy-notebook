// Capy (local change 46): the cursor preview of the board's polygons.
import type { RoughCanvas } from '@blocksuite/affine-block-surface';
import { POLYGON_SHAPES } from '@blocksuite/affine-model';

import { Shape } from './shape';
import { drawGeneralShape } from './utils';

export class PolygonShape extends Shape {
  draw(ctx: CanvasRenderingContext2D, rc: RoughCanvas): void {
    if (this.shapeStyle === 'Scribbled') {
      const [x, y, w, h] = this.xywh;
      rc.polygon(
        (POLYGON_SHAPES[this.type] ?? []).map(([fx, fy]) => [
          x + fx * w,
          y + fy * h,
        ]),
        this.options
      );
    } else {
      drawGeneralShape(ctx, this.type, this.xywh, this.options);
    }
  }
}
