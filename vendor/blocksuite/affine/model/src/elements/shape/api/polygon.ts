// Capy (local change 46): the board's polygon shapes (POLYGON_SHAPES), built as
// diamond.ts is from a polygon's corners.
import type { IBound, IVec } from '@blocksuite/global/gfx';
import {
  Bound,
  getCenterAreaBounds,
  getPointsFromBoundWithRotation,
  linePolygonIntersects,
  pointInPolygon,
  PointLocation,
  pointOnPolygonStoke,
  polygonGetPointTangent,
  polygonNearestPoint,
  rotatePoints,
} from '@blocksuite/global/gfx';
import type { PointTestOptions } from '@blocksuite/std/gfx';

import { DEFAULT_CENTRAL_AREA_RATIO } from '../../../consts/index.js';
import type { ShapeElementModel } from '../shape.js';

export function polygon(corners: [number, number][]) {
  const points = ({ x, y, w, h }: IBound): IVec[] =>
    corners.map(([fx, fy]) => [x + fx * w, y + fy * h]);

  return {
    points,
    draw(ctx: CanvasRenderingContext2D, bound: IBound) {
      const { x, y, w, h, rotate = 0 } = bound;
      const cx = x + w / 2;
      const cy = y + h / 2;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((rotate * Math.PI) / 180);
      ctx.translate(-cx, -cy);

      ctx.beginPath();
      points(bound).forEach(([px, py], i) => {
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();

      ctx.restore();
    },

    includesPoint(
      this: ShapeElementModel,
      x: number,
      y: number,
      options: PointTestOptions
    ) {
      const point: IVec = [x, y];
      const shape = getPointsFromBoundWithRotation(this, points);

      let hit = pointOnPolygonStoke(
        point,
        shape,
        (options?.hitThreshold ?? 1) / (options.zoom ?? 1)
      );

      if (!hit) {
        if (!options.ignoreTransparent || this.filled) {
          hit = pointInPolygon(point, shape);
        } else {
          const text = this.text;
          if (!text || !text.length) {
            const centralBounds = getCenterAreaBounds(
              this,
              DEFAULT_CENTRAL_AREA_RATIO
            );
            hit = pointInPolygon(
              point,
              getPointsFromBoundWithRotation(centralBounds, points)
            );
          } else if (this.textBound) {
            hit = pointInPolygon(
              point,
              getPointsFromBoundWithRotation(
                this,
                () => Bound.from(this.textBound!).points
              )
            );
          }
        }
      }

      return hit;
    },

    containsBound(bounds: Bound, element: ShapeElementModel) {
      return getPointsFromBoundWithRotation(element, points).some(point =>
        bounds.containsPoint(point)
      );
    },

    getNearestPoint(point: IVec, element: ShapeElementModel) {
      return polygonNearestPoint(
        getPointsFromBoundWithRotation(element, points),
        point
      );
    },

    getLineIntersections(start: IVec, end: IVec, element: ShapeElementModel) {
      return linePolygonIntersects(
        start,
        end,
        getPointsFromBoundWithRotation(element, points)
      );
    },

    getRelativePointLocation(position: IVec, element: ShapeElementModel) {
      const bound = Bound.deserialize(element.xywh);
      const point = bound.getRelativePoint(position);
      let shape = points(bound);
      shape.push(point);

      shape = rotatePoints(shape, bound.center, element.rotate);
      const rotatePoint = shape.pop() as IVec;
      const tangent = polygonGetPointTangent(shape, rotatePoint);
      return new PointLocation(rotatePoint, tangent);
    },
  };
}
