/* Capy (vendor/blocksuite/README.md, local change 62): what stands in for a stored
 * canvas element this editor can't read. */
import type { SerializedXYWH } from '@blocksuite/global/gfx';
import type * as Y from 'yjs';

import { field } from './decorators/index.js';
import { GfxPrimitiveElementModel } from './element-model.js';

export const UNKNOWN_ELEMENT_TYPE = 'capy:unknown';

/** An element of a type this editor has no model for, or one its editor says it
 * can't read: it keeps its place, order and turn, so it can be drawn as a
 * placeholder, picked and moved, and every other field stays in its map unread. */
export class UnknownElementModel extends GfxPrimitiveElementModel {
  /** No floating toolbar: none of its actions is for something unread. */
  readonly toolbar = false;

  get type() {
    return UNKNOWN_ELEMENT_TYPE;
  }

  @field(0)
  accessor rotate = 0;

  @field()
  accessor xywh: SerializedXYWH = '[0,0,0,0]';
}

const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value);

/** Whether a stored element has what the canvas needs of any element: a place, an
 * order, and a turn when it has one. One without is given no model at all. */
export function hasPlace(element: Y.Map<unknown>) {
  const xywh = element.get('xywh');
  const rotate = element.get('rotate');
  if (typeof xywh !== 'string' || typeof element.get('index') !== 'string')
    return false;
  if (rotate !== undefined && !finite(rotate)) return false;
  try {
    const place: unknown = JSON.parse(xywh);
    return Array.isArray(place) && place.length === 4 && place.every(finite);
  } catch {
    return false;
  }
}
