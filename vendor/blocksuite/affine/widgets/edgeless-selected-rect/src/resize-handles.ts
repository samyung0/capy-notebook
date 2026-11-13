import type { ResizeHandle } from '@blocksuite/std/gfx';
import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';

export enum HandleDirection {
  Bottom = 'bottom',
  BottomLeft = 'bottom-left',
  BottomRight = 'bottom-right',
  Left = 'left',
  Right = 'right',
  Top = 'top',
  TopLeft = 'top-left',
  TopRight = 'top-right',
}

function ResizeHandleRenderer(
  handle: ResizeHandle,
  onPointerDown?: (e: PointerEvent, direction: ResizeHandle) => void,
  getCursor?: (options: {
    type: 'resize' | 'rotate';
    handle: ResizeHandle;
  }) => string
) {
  const handlerPointerDown = (e: PointerEvent) => {
    e.stopPropagation();
    onPointerDown && onPointerDown(e, handle);
  };

  return html`<div
    class="handle"
    aria-label=${handle}
    @pointerdown=${handlerPointerDown}
  >
    <div
      class="resize transparent-handle"
      style=${styleMap({
        cursor: getCursor
          ? getCursor({
              type: 'resize',
              handle,
            })
          : 'default',
      })}
    ></div>
  </div>`;
}

/** Capy (local change 56): the rotate knob above the frame's middle, in place of
 * AFFiNE's hidden ring past each corner. It reports `top-right`, whose cursor is
 * the turning arrow upright. */
function RotateKnobRenderer(
  onPointerDown: (e: PointerEvent, direction: ResizeHandle) => void,
  getCursor?: (options: {
    type: 'resize' | 'rotate';
    handle: ResizeHandle;
  }) => string
) {
  const handle: ResizeHandle = 'top-right';
  return html`<div
    class="handle"
    aria-label="rotate"
    @pointerdown=${(e: PointerEvent) => {
      e.stopPropagation();
      onPointerDown(e, handle);
    }}
  >
    <div
      class="rotate"
      style=${styleMap({
        cursor: getCursor ? getCursor({ type: 'rotate', handle }) : 'default',
      })}
    ></div>
  </div>`;
}

/**
 * Indicate how selected elements can be resized.
 *
 * - edge: The selected elements can only be resized dragging edge, usually when note element is selected
 * - all: The selected elements can be resize both dragging edge or corner, usually when all elements are `shape`
 * - none: The selected elements can't be resized, usually when all elements are `connector`
 * - corner: The selected elements can only be resize dragging corner, this is by default mode
 * - edgeAndCorner: The selected elements can be resize both dragging left right edge or corner, usually when all elements are 'text'
 */
export type ResizeMode = 'edge' | 'all' | 'none' | 'corner' | 'edgeAndCorner';

export function RenderResizeHandles(
  resizeHandles: ResizeHandle[],
  rotatable: boolean,
  onPointerDown: (e: PointerEvent, direction: ResizeHandle) => void,
  getCursor?: (options: {
    type: 'resize' | 'rotate';
    handle: ResizeHandle;
  }) => string
) {
  return html`
    ${repeat(
      resizeHandles,
      handle => handle,
      handle => ResizeHandleRenderer(handle, onPointerDown, getCursor)
    )}
    ${rotatable ? RotateKnobRenderer(onPointerDown, getCursor) : nothing}
  `;
}
