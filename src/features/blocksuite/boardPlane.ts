import {
  type ElementRenderer,
  ElementRendererExtension,
  elementsCtorMap,
} from '@blocksuite/affine/blocks/surface';
import {
  Bound,
  type IVec,
  pointInPolygon,
  polygonNearestPoint,
  type SerializedXYWH,
} from '@blocksuite/affine/global/gfx';
import type { Color } from '@blocksuite/affine/model';
import {
  field,
  type GfxController,
  GfxElementModelView,
  GfxPrimitiveElementModel,
  GfxViewInteractionExtension,
} from '@blocksuite/affine/std/gfx';
import { axisNumber, tickStep } from '@/features/questions/graph';
import { minorStep, onCircle, smoothThrough, type Vec } from './boardGeometry';

/** What's plotted on a plane, in its own units. A line, curve or pie grows a click at
 * a time, each click one undo step. */
export type Mark =
  | { id: string; kind: 'dot'; at: Vec }
  | { id: string; kind: 'line' | 'curve'; points: Vec[] }
  | { fill: Color; h: number; id: string; kind: 'bar'; w: number; x: number }
  | { at: Vec; id: string; kind: 'pie'; radius: number; spokes: number[] };

/** The plane's top left corner in its own units, and board pixels per unit. */
export type PlaneView = { ppu: number; x0: number; y0: number };
export type Frame = { h: number; w: number; x: number; y: number };

/** Most marks one plane holds. */
export const MARKS_MAX = 500;

const DOT_RADIUS = 4.5;

export function drawPlane(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  view: PlaneView,
  marks: Mark[],
  resolve: (color: Color) => string
) {
  const X = (x: number) => frame.x + (x - view.x0) * view.ppu;
  const Y = (y: number) => frame.y + (view.y0 - y) * view.ppu;
  const left = view.x0;
  const right = view.x0 + frame.w / view.ppu;
  const top = view.y0;
  const bottom = view.y0 - frame.h / view.ppu;
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.x, frame.y, frame.w, frame.h);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.clip();

  const step = tickStep(view.ppu);
  const minor = minorStep(step);
  const grid = (every: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.ceil(left / every) * every; x <= right; x += every) {
      ctx.moveTo(X(x), frame.y);
      ctx.lineTo(X(x), frame.y + frame.h);
    }
    for (let y = Math.ceil(bottom / every) * every; y <= top; y += every) {
      ctx.moveTo(frame.x, Y(y));
      ctx.lineTo(frame.x + frame.w, Y(y));
    }
    ctx.stroke();
  };
  grid(minor, '#f1f1ef');
  grid(step, '#dededb');

  // Numbers sit by their axis and leave with it (Epo 2026-11-06).
  const axisX = X(0);
  const axisY = Y(0);
  ctx.strokeStyle = '#6f6f6c';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(axisX, frame.y);
  ctx.lineTo(axisX, frame.y + frame.h);
  ctx.moveTo(frame.x, axisY);
  ctx.lineTo(frame.x + frame.w, axisY);
  ctx.stroke();
  ctx.font = '12px Arial, sans-serif';
  ctx.fillStyle = '#55555b';
  ctx.textBaseline = 'middle';
  const label = (
    text: string,
    x: number,
    y: number,
    align: CanvasTextAlign
  ) => {
    if (!text) return;
    ctx.textAlign = align;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#fff';
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  };
  for (let x = Math.ceil(left / step) * step; x <= right; x += step)
    label(axisNumber(x, step), X(x), axisY + 14, 'center');
  for (let y = Math.ceil(bottom / step) * step; y <= top; y += step)
    label(axisNumber(y, step), axisX - 7, Y(y), 'right');

  // Marks keep their thickness whatever the plane's zoom.
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const dot = ([x, y]: Vec) => {
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(X(x), Y(y), DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  };
  const trace = (points: Vec[]) => {
    ctx.beginPath();
    for (const [i, [x, y]] of points.entries())
      if (i) ctx.lineTo(X(x), Y(y));
      else ctx.moveTo(X(x), Y(y));
    ctx.stroke();
  };
  for (const mark of marks) {
    if (mark.kind === 'dot') dot(mark.at);
    else if (mark.kind === 'bar') {
      const box = [
        X(mark.x),
        Y(Math.max(mark.h, 0)),
        mark.w * view.ppu,
        Math.abs(mark.h) * view.ppu,
      ] as const;
      ctx.fillStyle = resolve(mark.fill);
      ctx.fillRect(...box);
      ctx.strokeRect(...box);
    } else if (mark.kind === 'pie') {
      if (mark.radius) {
        ctx.beginPath();
        ctx.arc(
          X(mark.at[0]),
          Y(mark.at[1]),
          mark.radius * view.ppu,
          0,
          Math.PI * 2
        );
        ctx.stroke();
        for (const spoke of mark.spokes)
          trace([mark.at, onCircle(mark.at, mark.radius, spoke)]);
      } else dot(mark.at);
    } else {
      trace(mark.kind === 'curve' ? smoothThrough(mark.points) : mark.points);
      for (const point of mark.points) dot(point);
    }
  }
  ctx.restore();
  ctx.strokeStyle = '#d9d9d6';
  ctx.lineWidth = 1;
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
}

export class PlaneElementModel extends GfxPrimitiveElementModel<{
  index: string;
  marks: Mark[];
  ppu: number;
  rotate: number;
  seed: number;
  x0: number;
  xywh: SerializedXYWH;
  y0: number;
}> {
  get type() {
    return 'plane';
  }

  override containsBound(bounds: Bound) {
    return Bound.deserialize(this.xywh).points.some((point) =>
      bounds.containsPoint(point as IVec)
    );
  }

  /** The eraser asks this, so it leaves a card alone: its marks are erased inside. */
  override getLineIntersections() {
    return null;
  }

  override getNearestPoint(point: IVec) {
    return polygonNearestPoint(
      Bound.deserialize(this.xywh).points,
      point
    ) as IVec;
  }

  override includesPoint(x: number, y: number) {
    return pointInPolygon([x, y], Bound.deserialize(this.xywh).points);
  }

  @field()
  accessor marks: Mark[] = [];

  @field()
  accessor ppu = 41;

  @field(0)
  accessor rotate = 0;

  @field()
  accessor x0 = 0;

  @field()
  accessor xywh: SerializedXYWH = '[0,0,16,16]';

  @field()
  accessor y0 = 0;
}

// The surface builds its elements from this map when a board opens.
Object.assign(elementsCtorMap, { plane: PlaneElementModel });

const planeRenderer: ElementRenderer<PlaneElementModel> = (
  model,
  ctx,
  matrix,
  renderer
) => {
  const [, , w, h] = model.deserializedXYWH;
  ctx.setTransform(matrix);
  drawPlane(ctx, { h, w, x: 0, y: 0 }, model, model.marks, (color) =>
    renderer.getColorValue(color, 'transparent', true)
  );
};

/** The full-screen editor, set by its module so this one stays light. */
let openEditor: (gfx: GfxController, model: PlaneElementModel) => void = () =>
  undefined;
export function setPlaneEditor(open: typeof openEditor) {
  openEditor = open;
}

class PlaneElementView extends GfxElementModelView<PlaneElementModel> {
  static override type = 'plane';

  override onCreated() {
    super.onCreated();
    this.on('dblclick', () => openEditor(this.gfx, this.model));
  }
}

/** Resizing shows more or less of the plane at the same scale: dragging the left or
 * top edge keeps what's on the plane where it is on the page. A card doesn't rotate. */
const planeInteraction = GfxViewInteractionExtension<PlaneElementView>(
  'plane',
  {
    handleResize({ model }) {
      const { x0, y0 } = model;
      return {
        onResizeEnd(context) {
          context.default(context);
          model.pop('x0');
          model.pop('y0');
        },
        onResizeMove(context) {
          const { newBound, originalBound } = context;
          model.xywh = newBound.serialize();
          model.x0 = x0 + (newBound.x - originalBound.x) / model.ppu;
          model.y0 = y0 - (newBound.y - originalBound.y) / model.ppu;
        },
        onResizeStart(context) {
          context.default(context);
          model.stash('x0');
          model.stash('y0');
        },
      };
    },
    handleRotate() {
      return {
        beforeRotate(context) {
          context.set({ rotatable: false });
        },
      };
    },
  }
);

export const planeExtensions = [
  ElementRendererExtension('plane', planeRenderer),
  PlaneElementView,
  planeInteraction,
];

/** A card on the canvas, its plane's origin towards the lower left. */
export function addPlane(gfx: GfxController, box: Bound, ppu: number) {
  return gfx.surface?.addElement({
    marks: [],
    ppu,
    type: 'plane',
    x0: -1,
    xywh: box.serialize(),
    y0: (box.h * 0.7) / ppu,
  });
}

export function planeMarks(gfx: GfxController) {
  return gfx.layer.canvasElements
    .filter((element) => element.type === 'plane')
    .reduce(
      (count, element) => count + (element as PlaneElementModel).marks.length,
      0
    );
}
