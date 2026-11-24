import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import type { SurfaceBlockModel } from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { BrushStoreExtension } from '@blocksuite/affine/gfx/brush/store';
import type { IVec } from '@blocksuite/affine/global/gfx';
import type { BrushElementModel } from '@blocksuite/affine/model';
import { UnknownElementModel } from '@blocksuite/affine/std/gfx';
import { MemoryBlobSource } from '@blocksuite/affine/sync';
import { expect, it, onTestFinished, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
// BlockSuite's surface snapshot transformer, which its store entry doesn't export.
import { SurfaceBlockTransformer } from '../../../vendor/blocksuite/affine/blocks/surface/src/surface-transformer';
import { boardFirstState } from './boardFirstState';
import { savedCopy } from './boardKeep';
import { unknownStore } from './boardUnknown';
import { BLOCKS_ROOT, openRoomStore } from './roomStore';
import {
  decodeStrokePoints,
  encodeStrokePoints,
  isStrokePoints,
  strokeNearPoint,
  strokeView,
} from './strokePoints';

it('round-trips points with and without pressure as Float32s', () => {
  const plain = encodeStrokePoints([
    [0.1, 2],
    [3.5, -4],
  ]);
  expect(plain.length).toBe(4 + 2 * 2 * 4);
  expect(decodeStrokePoints(plain)).toEqual([
    [Math.fround(0.1), 2],
    [3.5, -4],
  ]);
  const pressed = encodeStrokePoints([[10, 20, 0.5]], [8, 8]);
  expect(decodeStrokePoints(pressed)).toEqual([[2, 12, 0.5]]);
  expect(decodeStrokePoints(encodeStrokePoints([]))).toEqual([]);
  expect([plain, pressed].every(isStrokePoints)).toBe(true);
});

it('reads aligned bytes in place and others from a copy', () => {
  const bytes = encodeStrokePoints([[1, 2, 0.25]]);
  expect(strokeView(bytes).values.buffer).toBe(bytes.buffer);
  const shifted = new Uint8Array(bytes.length + 1);
  shifted.set(bytes, 1);
  expect(decodeStrokePoints(shifted.subarray(1))).toEqual([[1, 2, 0.25]]);
});

it('takes only bytes with a header, whole points and finite values as stored points', () => {
  const bytes = encodeStrokePoints([[1, 2]]);
  const changed = (at: number, value: number) => {
    const copy = bytes.slice();
    copy[at] = value;
    return copy;
  };
  expect(
    [
      changed(0, 4),
      changed(1, 1),
      bytes.subarray(0, 10),
      encodeStrokePoints([[Number.NaN, 2]]),
      [[1, 2]],
      undefined,
    ].map(isStrokePoints)
  ).toEqual([false, false, false, false, false, false]);
  // Read anyway, as a model reads what the rules let through, they throw.
  expect(() => decodeStrokePoints([[1, 2]] as unknown as Uint8Array)).toThrow(
    'malformed stroke points'
  );
});

it("finds a dot's point and a line's segments", () => {
  const dot = encodeStrokePoints([[5, 5, 0]]);
  expect(strokeNearPoint(dot, 7, 5, 3)).toBe(true);
  const line = encodeStrokePoints([
    [0, 0],
    [10, 0],
    [10, 10],
  ]);
  expect(strokeNearPoint(line, 5, 1, 2)).toBe(true);
  expect(strokeNearPoint(line, 11, 5, 2)).toBe(true);
  expect(strokeNearPoint(line, 5, 5, 2)).toBe(false);
});

// The eraser's box test reads the stroke's box through the DOM's DOMRect.
vi.stubGlobal(
  'DOMRect',
  class {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
    constructor(left: number, top: number, width: number, height: number) {
      this.left = left;
      this.top = top;
      this.width = width;
      this.height = height;
    }
  }
);

const stores = new StoreExtensionManager([
  RootStoreExtension,
  SurfaceStoreExtension,
  BrushStoreExtension,
]);

/** A canvas's room opened as the board opens it, with a pen stroke drawn through
 * three points with pressure. */
function drawn() {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, boardFirstState(), 'room');
  const { dispose, store } = openRoomStore({
    awareness: new Awareness(doc),
    blobs: { main: new MemoryBlobSource() },
    doc,
    id: 'cv_1',
    readonly: false,
    storeExtensions: [...stores.get('store'), ...unknownStore('workspace')],
  });
  onTestFinished(dispose);
  const surface = store.getModelsByFlavour(
    'affine:surface'
  )[0] as SurfaceBlockModel;
  const id = surface.addElement({
    points: [
      [10, 10, 0.5],
      [30, 25, 0.75],
      [60, 20, 0.25],
    ],
    type: 'brush',
  });
  const stroke = surface.getElementById(id) as BrushElementModel;
  return { doc, id, store, stroke, surface };
}

/** A stored element's map in a copy of the room's document. */
function elementIn(doc: Y.Doc, id: string) {
  const surface = [...doc.getMap<Y.Map<unknown>>(BLOCKS_ROOT).values()].find(
    (block) => block.get('sys:flavour') === 'affine:surface'
  ) as Y.Map<unknown>;
  const elements = (surface.get('prop:elements') as Y.Map<unknown>).get(
    'value'
  ) as Y.Map<unknown>;
  return elements.get(id) as Y.Map<unknown>;
}

it("stores a drawn stroke as one binary value, from its box's corner", () => {
  const { stroke } = drawn();
  expect(stroke.yMap.get('points')).toBeInstanceOf(Uint8Array);
  // The box is a line's width wider than the points.
  expect(stroke.xywh).toBe('[8,8,54,19]');
  expect(stroke.serialize().points).toEqual([
    [2, 2, 0.5],
    [22, 17, 0.75],
    [52, 12, 0.25],
  ]);
});

it('moves a stroke with its box, its points as they were', () => {
  const { id, stroke, surface } = drawn();
  surface.updateElement(id, { xywh: '[108,8,54,19]' });
  expect(decodeStrokePoints(stroke.points)[0]).toEqual([2, 2, 0.5]);
  expect(stroke.includesPoint(110, 10)).toBe(true);
  expect(stroke.includesPoint(10, 10)).toBe(false);
});

it('hits a turned stroke where it is drawn', () => {
  const { id, stroke, surface } = drawn();
  // Turned half round its box's centre (35, 17.5), the middle point (30, 25)
  // is at (40, 10).
  surface.updateElement(id, { rotate: 180 });
  expect(stroke.includesPoint(40, 10)).toBe(true);
  expect(stroke.includesPoint(30, 25)).toBe(false);
});

it("scales a stroke's points with its box", () => {
  const { id, stroke, surface } = drawn();
  surface.updateElement(id, { xywh: '[8,8,104,34]' });
  expect(stroke.xywh).toBe('[8,8,104,34]');
  expect(stroke.serialize().points).toEqual([
    [2, 2, 0.5],
    [42, 32, 0.75],
    [102, 22, 0.25],
  ]);
});

it('pastes a stroke at its place with its points', () => {
  const { stroke, surface } = drawn();
  const { id: _, ...copy } = structuredClone(stroke.serialize());
  const pasted = surface.getElementById(
    surface.addElement({ ...copy, type: 'brush' })
  ) as BrushElementModel;
  expect(pasted.xywh).toBe(stroke.xywh);
  expect(pasted.serialize().points).toEqual(stroke.serialize().points);
});

it("meets the eraser's line across it, and is erased", () => {
  const { id, stroke, surface } = drawn();
  const across: [IVec, IVec] = [
    [30, 0],
    [30, 100],
  ];
  expect(stroke.getLineIntersections(...across)).not.toBeNull();
  expect(stroke.getLineIntersections([30, 200], [200, 200])).toBeNull();
  surface.deleteElement(id);
  expect(surface.getElementById(id)).toBeNull();
});

it("rounds a saved copy's points to whole units and keeps their pressure", () => {
  const { doc, id, stroke } = drawn();
  doc.transact(() =>
    stroke.yMap.set('points', encodeStrokePoints([[2.4, 3.6, 0.5]]))
  );
  const saved = new Y.Doc();
  Y.applyUpdate(saved, savedCopy(doc, 'workspace'));
  expect(
    decodeStrokePoints(elementIn(saved, id).get('points') as Uint8Array)
  ).toEqual([[2, 4, 0.5]]);
});

it("keeps a stroke's points through its canvas's JSON snapshot", () => {
  const { id, store, stroke, surface } = drawn();
  const snapshot: {
    props: { elements: Record<string, Record<string, unknown>> };
  } = JSON.parse(
    JSON.stringify(store.getTransformer().blockToSnapshot(surface))
  );
  const json = snapshot.props.elements[id];
  expect(json.points).toEqual({
    'affine:surface:bytes': true,
    bytes: Array.from(stroke.points),
  });
  const element = new SurfaceBlockTransformer(new Map()).elementFromJSON(json);
  new Y.Doc().getMap().set(id, element);
  expect(element.get('points')).toEqual(stroke.points);
});

it('reads a stroke a peer overwrote with number arrays as a placeholder, and drawing goes on', () => {
  const { doc, id, surface } = drawn();
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(doc);
  elementIn(peer, id).set('points', [[1, 2]]);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, before), 'room');

  const placeholder = surface.getElementById(id);
  expect(placeholder).toBeInstanceOf(UnknownElementModel);
  expect(placeholder?.xywh).toBe('[8,8,54,19]');
  // What the peer wrote stays as it is.
  expect(elementIn(doc, id).get('points')).toEqual([[1, 2]]);
  const next = surface.getElementById(
    surface.addElement({
      points: [
        [100, 100],
        [140, 120],
      ],
      type: 'brush',
    })
  ) as BrushElementModel;
  expect(next.includesPoint(120, 110)).toBe(true);
  expect(surface.getElementsByType('brush')).toEqual([next]);
});
