import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import type { SurfaceBlockModel } from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { ConnectorElementView } from '@blocksuite/affine/gfx/connector';
import { ConnectorStoreExtension } from '@blocksuite/affine/gfx/connector/store';
import { ShapeStoreExtension } from '@blocksuite/affine/gfx/shape/store';
import { Bound } from '@blocksuite/affine/global/gfx';
import type { ConnectorElementModel } from '@blocksuite/affine/model';
import type {
  DragEndContext,
  DragMoveContext,
  DragStartContext,
  GfxController,
  GfxPrimitiveElementModel,
} from '@blocksuite/affine/std/gfx';
import { MemoryBlobSource } from '@blocksuite/affine/sync';
import { expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { boardFirstState } from './boardFirstState';
import { unknownStore } from './boardUnknown';
import { openRoomStore } from './roomStore';

/* A connector's label on a shared canvas (vendor/blocksuite local change 63):
 * its place is stored, and only the tab whose own action moved it writes it. */

const stores = new StoreExtensionManager([
  RootStoreExtension,
  SurfaceStoreExtension,
  ShapeStoreExtension,
  ConnectorStoreExtension,
]);

/** A tab on the room: its document, its store, and the updates it wrote
 * itself (what it would send). */
function tab(state: Uint8Array, readonly = false) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state, 'room');
  const sent: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'room') sent.push(update);
  });
  const { store } = openRoomStore({
    awareness: new Awareness(doc),
    blobs: { main: new MemoryBlobSource() },
    doc,
    id: 'cv_1',
    readonly,
    storeExtensions: [...stores.get('store'), ...unknownStore('workspace')],
  });
  const surface = store.getModelsByFlavour(
    'affine:surface'
  )[0] as SurfaceBlockModel;
  return { doc, sent, store, surface };
}

/** The connector watcher works a microtask after a change. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const shape = (x: number) => ({
  shapeType: 'rect',
  type: 'shape',
  xywh: `[${x},0,100,100]`,
});

/** A room holding two shapes joined by a labelled connector, as its maker's
 * tab leaves it. */
async function labelledBoard() {
  const maker = tab(boardFirstState());
  const from = maker.surface.addElement(shape(0));
  const to = maker.surface.addElement(shape(400));
  const connector = maker.surface.addElement({
    labelDisplay: true,
    labelOffset: { distance: 0.5 },
    labelXYWH: [0, 0, 60, 24],
    mode: 0,
    source: { id: from },
    target: { id: to },
    text: new Y.Text('feeds'),
    type: 'connector',
  });
  await settled();
  return { connector, from, maker };
}

const labelOf = (
  { surface }: ReturnType<typeof tab>,
  id: string
): number[] | undefined =>
  (surface.getElementById(id) as ConnectorElementModel).labelXYWH;

it('opens a board holding a labelled connector and writes nothing', async () => {
  const { maker } = await labelledBoard();
  const state = Y.encodeStateAsUpdate(maker.doc);
  const editor = tab(state);
  const viewer = tab(state, true);
  await settled();
  expect(editor.sent).toEqual([]);
  expect(viewer.sent).toEqual([]);
  expect(editor.store.canUndo).toBe(false);
});

it("places the label with its maker's move, and the other tabs write nothing", async () => {
  const { connector, from, maker } = await labelledBoard();
  const state = Y.encodeStateAsUpdate(maker.doc);
  const editor = tab(state);
  const viewer = tab(state, true);
  // The editor has a step of its own to take back, then takes it back.
  const own = editor.surface.addElement(shape(800));
  Y.applyUpdate(maker.doc, Y.encodeStateAsUpdate(editor.doc), 'room');
  editor.store.undo();
  await settled();
  editor.sent.length = 0;
  const before = labelOf(maker, connector);

  // The maker moves a shape the connector hangs on: its own tab moves the label.
  const relay: Uint8Array[] = [];
  maker.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'room') relay.push(update);
  });
  maker.surface.updateElement(from, { xywh: '[0,300,100,100]' });
  await settled();
  expect(labelOf(maker, connector)).not.toEqual(before);
  for (const update of relay) {
    Y.applyUpdate(editor.doc, update, 'room');
    Y.applyUpdate(viewer.doc, update, 'room');
  }
  await settled();

  // The others show it where the maker's tab put it, and wrote nothing.
  expect(labelOf(editor, connector)).toEqual(labelOf(maker, connector));
  expect(labelOf(viewer, connector)).toEqual(labelOf(maker, connector));
  expect(editor.sent).toEqual([]);
  expect(viewer.sent).toEqual([]);
  // The editor's Undo and Redo are as they were: nothing new to undo, and the
  // step taken back can still be done again.
  expect(editor.store.canUndo).toBe(false);
  expect(editor.store.canRedo).toBe(true);
  editor.store.redo();
  expect(editor.surface.hasElementById(own)).toBe(true);
});

it("drags a connector with its free ends and label this tab's, writing each once at the end", async () => {
  const maker = tab(boardFirstState());
  const id = maker.surface.addElement({
    labelDisplay: true,
    labelOffset: { distance: 0.5 },
    labelXYWH: [70, -12, 60, 24],
    mode: 0,
    source: { position: [0, 0] },
    target: { position: [200, 0] },
    text: new Y.Text('feeds'),
    type: 'connector',
  });
  await settled();
  const connector = maker.surface.getElementById(id) as ConnectorElementModel;
  // BlockSuite's drag hands the element's view the bound it started from and
  // the pointer's distance on every frame (local change 80).
  const view = new ConnectorElementView(connector, {} as GfxController);
  const start = Bound.deserialize(connector.xywh);
  maker.sent.length = 0;
  view.onDragStart({} as DragStartContext);
  for (const dy of [10, 20, 30]) {
    view.onDragMove({ currentBound: start, dx: 0, dy } as DragMoveContext);
    await settled();
  }
  expect(maker.sent).toEqual([]);
  expect(connector.source.position).toEqual([0, 30]);

  view.onDragEnd({} as DragEndContext);
  await settled();
  expect(maker.sent).toHaveLength(3);
  const stored = maker.surface.getElementById(id) as ConnectorElementModel;
  expect(stored.yMap.get('source')).toEqual({ position: [0, 30] });
  expect(stored.yMap.get('target')).toEqual({ position: [200, 30] });
  expect(stored.yMap.get('labelXYWH')).toEqual([70, 18, 60, 24]);
});

// Local change 83: a labelled connector hanging on a shape in the middle of a
// drag wrote its label at every frame (about 20 B a label a frame, on any
// board). Fails if a frame writes, or if the labels are not written inside the
// change that ends the drag (Undo would take them back apart from it).
it("holds the labels hanging on a shape mid-drag this tab's, and writes each once as the drag ends, taken back with it", async () => {
  const maker = tab(boardFirstState());
  const from = maker.surface.addElement(shape(0));
  const to = maker.surface.addElement(shape(400));
  const connectors = [0, 1].map(() =>
    maker.surface.addElement({
      labelDisplay: true,
      labelOffset: { distance: 0.5 },
      labelXYWH: [0, 0, 60, 24],
      mode: 0,
      source: { id: from },
      target: { id: to },
      text: new Y.Text('feeds'),
      type: 'connector',
    })
  );
  await settled();
  const before = connectors.map((id) => labelOf(maker, id));
  const moving = maker.surface.getElementById(from) as GfxPrimitiveElementModel;
  maker.store.captureSync();
  maker.sent.length = 0;
  // BlockSuite's drag stashes the shape's box and sets it on every frame.
  moving.stash('xywh');
  for (const y of [100, 200, 300]) {
    moving.xywh = `[0,${y},100,100]`;
    await settled();
  }
  expect(maker.sent).toEqual([]);
  const shown = connectors.map((id) => labelOf(maker, id));
  expect(shown).not.toEqual(before);

  // The drag's end stores the box, and the labels inside that change.
  maker.store.transact(() => moving.pop('xywh'));
  expect(maker.sent).toHaveLength(3);
  expect(
    connectors.map((id) =>
      (maker.surface.getElementById(id) as ConnectorElementModel).yMap.get(
        'labelXYWH'
      )
    )
  ).toEqual(shown);
  maker.store.captureSync();
  maker.store.undo();
  await settled();
  expect(connectors.map((id) => labelOf(maker, id))).toEqual(before);
});

it('takes a move back with its label, and can do it again', async () => {
  const { connector, from, maker } = await labelledBoard();
  const before = labelOf(maker, connector);
  maker.store.captureSync();
  maker.surface.updateElement(from, { xywh: '[0,300,100,100]' });
  await settled();
  const moved = labelOf(maker, connector);
  expect(moved).not.toEqual(before);
  maker.store.undo();
  await settled();
  expect(labelOf(maker, connector)).toEqual(before);
  expect(maker.store.canRedo).toBe(true);
  maker.store.redo();
  await settled();
  expect(labelOf(maker, connector)).toEqual(moved);
});
