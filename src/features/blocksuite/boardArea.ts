import { DefaultTool } from '@blocksuite/affine/blocks/surface';
import { Bound } from '@blocksuite/affine/global/gfx';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import type { Store } from '@blocksuite/affine/store';
import type * as Y from 'yjs';
import {
  AREA_H,
  AREA_PROP as AREA_KEY,
  AREA_W,
  areaBox,
} from './boardGeometry';

/* A question board's answer area on a mounted board (boardGeometry.ts says where
 * it is kept). On screen it is a dashed box with a label; the teacher's moves
 * alone, picked up by its label or its edge. */

const pageOf = (store: Store) => {
  const page = store.root?.yBlock;
  if (!page) throw new Error('drawing board: no page');
  return page;
};

/** The area on a mounted board, in board units. */
export const storedArea = (store: Store) => {
  const { h, w, x, y } = areaBox(pageOf(store).get(AREA_KEY));
  return new Bound(x, y, w, h);
};

/** Moves the area's top left to whole board units, one step to undo. */
export function moveArea(store: Store, x: number, y: number) {
  const page = pageOf(store);
  store.captureSync();
  store.transact(() => page.set(AREA_KEY, [Math.round(x), Math.round(y)]));
  store.captureSync();
}

/** The label's height on screen, and how near its edge a press picks the area up,
 * in pixels. */
const CHIP_H = 20;
const EDGE_REACH = 6;

/** The area's dashed box (in the moving layer, before `under`) and its label, the
 * same size on screen at every zoom (`zoom`). It follows the stored place (a move,
 * an undo). `movable`: under the Select tool, a press on the label or the edge
 * drags the area alone, and lets go of it in its new place. */
export function mountAnswerArea({
  board,
  gfx,
  label,
  layer,
  movable,
  store,
  under,
}: {
  board: HTMLElement;
  gfx: GfxController;
  label: string;
  layer: HTMLElement;
  movable: boolean;
  store: Store;
  under: Element;
}) {
  const svg = 'http://www.w3.org/2000/svg';
  const box = document.createElementNS(svg, 'svg');
  box.classList.add('capy-answer-box');
  box.style.cssText =
    'position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible';
  const rect = document.createElementNS(svg, 'rect');
  rect.setAttribute('width', String(AREA_W));
  rect.setAttribute('height', String(AREA_H));
  rect.setAttribute('fill', 'none');
  rect.setAttribute('stroke', '#9aa0a6');
  box.append(rect);
  const chip = document.createElement('div');
  chip.className = 'capy-answer-area';
  chip.textContent = label;
  chip.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;white-space:nowrap;height:${CHIP_H}px;padding:0 7px;border-radius:4px 4px 4px 0;background:#222;color:#fff;font:600 12px/${CHIP_H}px var(--affine-font-family)`;
  under.before(box);
  layer.append(chip);

  const page = pageOf(store);
  let stored = areaBox(page.get(AREA_KEY));
  // Where it is drawn: the stored place, or where a drag has it.
  let x = stored.x;
  let y = stored.y;
  let zoom = 1;
  const draw = () => {
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    // The label's bottom left on the box's top left corner.
    chip.style.transform = `translate(${x}px,${y}px) scale(${1 / zoom}) translateY(-100%)`;
  };
  const onPage = (event: Y.YMapEvent<unknown>) => {
    if (!event.keysChanged.has(AREA_KEY)) return;
    stored = areaBox(page.get(AREA_KEY));
    x = stored.x;
    y = stored.y;
    draw();
  };
  page.observe(onPage);
  draw();

  // The teacher's: picked up by its label or edge, under the Select tool.
  let chipW = 0;
  let hot = false;
  let drag: {
    id: number;
    x: number;
    y: number;
    cx: number;
    cy: number;
  } | null = null;
  const scale = () => gfx.viewport.zoom * gfx.viewport.viewScale;
  /** Whether a pointer at (cx, cy) on the page is on the label or the edge. */
  const onHandle = (cx: number, cy: number) => {
    const { left: vl, top: vt, viewportX, viewportY } = gfx.viewport;
    const k = scale();
    const left = vl + (x - viewportX) * k;
    const top = vt + (y - viewportY) * k;
    const right = left + AREA_W * k;
    const bottom = top + AREA_H * k;
    chipW ||= chip.offsetWidth;
    if (cx >= left && cx <= left + chipW && cy >= top - CHIP_H && cy <= top)
      return true;
    if (
      cx < left - EDGE_REACH ||
      cx > right + EDGE_REACH ||
      cy < top - EDGE_REACH ||
      cy > bottom + EDGE_REACH
    )
      return false;
    return (
      Math.abs(cx - left) <= EDGE_REACH ||
      Math.abs(cx - right) <= EDGE_REACH ||
      Math.abs(cy - top) <= EDGE_REACH ||
      Math.abs(cy - bottom) <= EDGE_REACH
    );
  };
  const canMove = () =>
    !store.readonly &&
    gfx.tool.currentToolName$.peek() === DefaultTool.toolName;
  const setHot = (on: boolean) => {
    if (on === hot) return;
    hot = on;
    board.toggleAttribute('data-area-handle', on);
    box.toggleAttribute('data-hot', on);
  };
  const onMove = (event: PointerEvent) => {
    if (drag) {
      if (event.pointerId !== drag.id) return;
      const k = scale();
      x = drag.x + (event.clientX - drag.cx) / k;
      y = drag.y + (event.clientY - drag.cy) / k;
      draw();
      return;
    }
    if (event.buttons) return;
    setHot(canMove() && onHandle(event.clientX, event.clientY));
  };
  const onDown = (event: PointerEvent) => {
    if (drag || event.button !== 0 || !canMove()) return;
    if (!onHandle(event.clientX, event.clientY)) return;
    // BlockSuite never hears the press: no selection, no box selecting.
    event.preventDefault();
    event.stopPropagation();
    gfx.selection.clear();
    board.setPointerCapture(event.pointerId);
    drag = {
      cx: event.clientX,
      cy: event.clientY,
      id: event.pointerId,
      x: stored.x,
      y: stored.y,
    };
    setHot(true);
  };
  const onUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    if (event.type === 'pointerup' && (x !== stored.x || y !== stored.y))
      moveArea(store, x, y);
    else {
      x = stored.x;
      y = stored.y;
      draw();
    }
    setHot(onHandle(event.clientX, event.clientY));
  };
  const events = [
    ['pointermove', onMove],
    ['pointerdown', onDown],
    ['pointerup', onUp],
    ['pointercancel', onUp],
  ] as const;
  if (movable)
    for (const [type, listener] of events)
      board.addEventListener(type, listener, true);

  return {
    /** The stored area, in board units. */
    bound: () => new Bound(stored.x, stored.y, AREA_W, AREA_H),
    dispose: () => {
      page.unobserve(onPage);
      if (movable)
        for (const [type, listener] of events)
          board.removeEventListener(type, listener, true);
      board.removeAttribute('data-area-handle');
      box.remove();
      chip.remove();
    },
    /** Keeps its line and label the same size on screen. */
    zoom: (to: number) => {
      zoom = to;
      rect.setAttribute('stroke-width', String(1.5 / zoom));
      rect.setAttribute('stroke-dasharray', `${8 / zoom} ${6 / zoom}`);
      draw();
    },
  };
}

/** Whether any of `items` lies wholly or partly outside `area`. */
export const anyOutside = (
  area: Bound,
  items: readonly { elementBound: Bound }[]
) => items.some((item) => !area.contains(item.elementBound));
