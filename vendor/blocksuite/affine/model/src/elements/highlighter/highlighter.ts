import {
  Bound,
  getBoundFromPoints,
  getPointsFromBoundWithRotation,
  getQuadBoundWithRotation,
  getSolidStrokePoints,
  getSvgPathFromStroke,
  inflateBound,
  type IVec,
  lineIntersects,
  PointLocation,
  polyLineNearestPoint,
  rotatePoint,
  type SerializedXYWH,
  transformPointsToNewBound,
  Vec,
} from '@blocksuite/global/gfx';
import type { BaseElementProps, PointTestOptions } from '@blocksuite/std/gfx';
import {
  convert,
  derive,
  field,
  GfxPrimitiveElementModel,
  watch,
} from '@blocksuite/std/gfx';

import {
  decodeStrokePoints,
  encodeStrokePoints,
  strokeNearPoint,
} from '@/features/blocksuite/strokePoints';

import { DEFAULT_HIGHLIGHTER_LINE_WIDTH } from '../../consts';
import { type Color, DefaultTheme } from '../../themes/index';

export type HighlighterProps = BaseElementProps & {
  /**
   * Capy (local change 79): the points as stored, relative to `xywh`, in one
   * binary value (`strokePoints.ts`): x and y, and pressure where the pen gave
   * one. Set them as drawn, `[[x0,y0,pressure0?],...]` in board units: `convert`
   * stores them, and `serialize` gives them back that way (relative).
   */
  points: Uint8Array;
  color: Color;
  lineWidth: number;
};

export class HighlighterElementModel extends GfxPrimitiveElementModel<HighlighterProps> {
  /**
   * The SVG path commands for the brush.
   */
  get commands() {
    if (!this._local.has('commands')) {
      const stroke = getSolidStrokePoints(
        decodeStrokePoints(this.points),
        this.lineWidth
      );
      const commands = getSvgPathFromStroke(stroke);

      this._local.set('commands', commands);
    }

    return this._local.get('commands') as string;
  }

  override get connectable() {
    return false;
  }

  override get type() {
    return 'highlighter';
  }

  override containsBound(bounds: Bound) {
    const points = getPointsFromBoundWithRotation(this);
    return points.some(point => bounds.containsPoint(point));
  }

  override getLineIntersections(start: IVec, end: IVec) {
    const box = Bound.fromDOMRect(getQuadBoundWithRotation(this));

    if (box.w < 8 && box.h < 8) {
      return Vec.distanceToLineSegment(start, end, box.center) < 5 ? [] : null;
    }

    if (box.intersectLine(start, end, true)) {
      // Capy (local change 79): decoded only for a line that crosses the box, as
      // the eraser asks every stroke on every move.
      const tl = [this.x, this.y];
      const points = getPointsFromBoundWithRotation(this, _ =>
        decodeStrokePoints(this.points).map(point => Vec.add(point, tl))
      );
      const len = points.length;
      for (let i = 1; i < len; i++) {
        const result = lineIntersects(start, end, points[i - 1], points[i]);
        if (result) {
          return [
            new PointLocation(
              result,
              Vec.normalize(Vec.sub(points[i], points[i - 1]))
            ),
          ];
        }
      }
    }
    return null;
  }

  override getNearestPoint(point: IVec): IVec {
    const { x, y } = this;

    return polyLineNearestPoint(
      decodeStrokePoints(this.points).map(p => Vec.add(p, [x, y])),
      point
    ) as IVec;
  }

  override getRelativePointLocation(position: IVec): PointLocation {
    const point = Bound.deserialize(this.xywh).getRelativePoint(position);
    return new PointLocation(point);
  }

  override includesPoint(
    px: number,
    py: number,
    options?: PointTestOptions
  ): boolean {
    // Capy (local change 79): the stored points read in place, the pointer
    // turned back about the box's centre.
    const bound = Bound.deserialize(this.xywh);
    const [x, y] = this.rotate
      ? rotatePoint([px, py], bound.center, -this.rotate)
      : [px, py];
    return strokeNearPoint(
      this.points,
      x - bound.x,
      y - bound.y,
      (options?.hitThreshold ?? 10) / Math.min(options?.zoom ?? 1, 1)
    );
  }

  /** Capy (local change 79): the points as drawn (relative), which a copy, a
   * paste and Duplicate hand back to `points`. */
  override serialize() {
    const result = super.serialize();
    result.points = decodeStrokePoints(this.points);
    return result;
  }

  @field()
  accessor color: Color = DefaultTheme.hightlighterColor;

  @watch((_, instance) => {
    instance['_local'].delete('commands');
  })
  @derive((lineWidth: number, instance: Instance) => {
    const oldBound = Bound.fromXYWH(instance.deserializedXYWH);

    if (
      lineWidth === instance.lineWidth ||
      oldBound.w === 0 ||
      oldBound.h === 0
    )
      return {};

    const points = decodeStrokePoints(instance.points);
    const transformed = transformPointsToNewBound(
      points.map(([x, y]) => ({ x, y })),
      oldBound,
      instance.lineWidth / 2,
      inflateBound(oldBound, lineWidth - instance.lineWidth),
      lineWidth / 2
    );

    return {
      points: transformed.points.map((p, i) => [
        p.x,
        p.y,
        ...(points[i][2] !== undefined ? [points[i][2]] : []),
      ]),
      xywh: transformed.bound.serialize(),
    };
  })
  @field()
  accessor lineWidth: number = DEFAULT_HIGHLIGHTER_LINE_WIDTH;

  @watch((_, instance) => {
    instance['_local'].delete('commands');
  })
  @derive((points: IVec[], instance: Instance) => {
    const lineWidth = instance.lineWidth;
    const bound = getBoundFromPoints(points);
    const boundWidthLineWidth = inflateBound(bound, lineWidth);

    return {
      xywh: boundWidthLineWidth.serialize(),
    };
  })
  @convert((points: number[][], instance) => {
    const lineWidth = instance.lineWidth;
    const bound = getBoundFromPoints(points as IVec[]);
    const boundWidthLineWidth = inflateBound(bound, lineWidth);

    return encodeStrokePoints(points, [
      boundWidthLineWidth.x,
      boundWidthLineWidth.y,
    ]);
  })
  @field()
  accessor points: Uint8Array = encodeStrokePoints([]);

  @field(0)
  accessor rotate: number = 0;

  @derive((xywh: SerializedXYWH, instance: Instance) => {
    const bound = Bound.deserialize(xywh);

    if (bound.w === instance.w && bound.h === instance.h) return {};

    const { lineWidth } = instance;
    const points = decodeStrokePoints(instance.points);
    const transformed = transformPointsToNewBound(
      points.map(([x, y]) => ({ x, y })),
      instance,
      instance.lineWidth / 2,
      bound,
      lineWidth / 2
    );

    return {
      points: transformed.points.map((p, i) => [
        p.x,
        p.y,
        ...(points[i][2] !== undefined ? [points[i][2]] : []),
      ]),
    };
  })
  @field()
  accessor xywh: SerializedXYWH = '[0,0,0,0]';
}

type Instance = GfxPrimitiveElementModel<HighlighterProps> & HighlighterProps;
